import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import { MongoClient, ObjectId } from 'mongodb'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

const app = express()
const port = process.env.PORT || 5000

// ---------- Middleware ----------
app.use(express.json({ limit: "100kb" }))
// Only the Next.js app may call this API from a browser
// app.use(cors({ origin: process.env.CLIENT_URL || "http://localhost:3000" }))
// CLIENT_URL = comma-separated list of allowed sites
const allowedOrigins = [
  "http://localhost:3000",
  "https://pizzahub-client-liart-gamma.vercel.app",
]

app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
)
// ---------- MongoDB ----------
const client = new MongoClient(
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.oborgny.mongodb.net/`
)

const myLogger = (req, res, next) => {
  console.log('now ', req.url, req.query)
  next()
}





export async function connectToMongoDB() {
  try {
    await client.connect()
    console.log("You successfully connected to MongoDB!")
    return client
  } catch (err) {
    console.dir(err)
  }
}

await connectToMongoDB()
const database = client.db("pizzahubdb")
const user = database.collection("user")
const menu = database.collection("menuData")
const sessions = database.collection('session')
const orders = database.collection('orders')
const payments = database.collection('payments')
// Read-only payment history shown to admins and vendors
const transactions = database.collection('transactions')

// Two separate profile collections:
//   vendorProfile   -> accounts whose role is "vendor" (restaurant details)
//   customerProfile -> customers and admins (personal details only)
// The OLD single `profile` collection is no longer used. Run
// migrate-profiles.mjs once to copy its documents into these two.
const vendorProfile = database.collection("vendorProfile")
const customerProfile = database.collection("customerProfile")

// One profile per email, enforced by the database itself
for (const collection of [vendorProfile, customerProfile]) {
  try {
    await collection.createIndex({ email: 1 }, { unique: true })
  } catch (error) {
    console.error("Could not create the email index:", error.message)
  }
}



// ---------- Helpers ----------

const clean = (value) => (typeof value === "string" ? value.trim() : "")
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// ---------- Authentication & authorization ----------


const forbidden = (res, message = "You are not allowed to do this") =>
  res.status(403).send({ success: false, message })

// Reads the user id out of a JWT (when JWKS_URL is set in .env), or out of the
// session token stored by Better Auth (default). Returns null when invalid.
let jwks = null
const userIdFromToken = async (token) => {
  try {
    if (process.env.JWKS_URL) {
      // JWT mode: npm i jose, then set JWKS_URL=http://localhost:3000/api/auth/jwks
      const { createRemoteJWKSet, jwtVerify } = await import("jose")
      jwks ||= createRemoteJWKSet(new URL(process.env.JWKS_URL))
      const { payload } = await jwtVerify(token, jwks)
      return String(payload.id ?? payload.sub ?? "") || null
    }

    // Session-token mode
    const session = await sessions.findOne({
      token,
      expiresAt: { $gt: new Date() },
    })
    return session ? String(session.userId) : null
  } catch {
    return null
  }
}

const verifyToken = async (req, res, next) => {

  try {
    const authHeader = req.headers.authorization

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .send({ success: false, message: "Unauthorized: token missing" })
    }

    const token = authHeader.split(" ")[1]
    if (!token) {
      return res.status(401).send({ success: false, message: "Token missing" })
    }

    const uid = await userIdFromToken(token)
    if (!uid) {
      return res
        .status(401)
        .send({ success: false, message: "Invalid or expired token" })
    }

    const account = await user.findOne(
      ObjectId.isValid(uid)
        ? { $or: [{ _id: new ObjectId(uid) }, { id: uid }] }
        : { id: uid }
    )
    if (!account) {
      return res.status(401).send({ success: false, message: "User not found" })
    }

    // The role and the blocked status are read from the database on every
    // request, so an admin's block or a role change takes effect immediately.
    if (account.status === "blocked") return blockedResponse(res)

    req.user = account
    next()
  } catch (error) {
    console.error("Authentication error:", error)
    return res
      .status(500)
      .send({ success: false, message: "Authentication failed" })
  }
}




const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.role) ? next() : forbidden(res)

// Is the signed-in user the owner of something stored under `ownerEmail`?
const isOwner = (req, ownerEmail) =>
  clean(ownerEmail).toLowerCase() === clean(req.user?.email).toLowerCase()

const isOwnerOrAdmin = (req, ownerEmail) =>
  req.user?.role === "admin" || isOwner(req, ownerEmail)

// The :email in a URL must be the signed-in user's own email
const ownsEmail = (req, email) => isOwner(req, email)

// Free vendors can publish this many active (available) menu items
const FREE_ACTIVE_ITEM_LIMIT = 3

// The account's role (user collection) decides which profile collection to use
const profileCollectionFor = (role) =>
  role === "vendor" ? vendorProfile : customerProfile

// A business is premium when the account that owns it has premium: true.
// Business names live on the vendor profile, accounts live in the user collection.
async function findBusinessOwner(businessName) {
  const name = clean(businessName)
  if (!name) return null

  const profileDoc = await vendorProfile.findOne({
    businessName: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
  })

  const email = (profileDoc?.email || "").toLowerCase()
  if (!email) return null

  const account = await user.findOne({ email })
  if (!account) return null

  return { profile: profileDoc, account }
}

async function isPremiumBusiness(businessName) {
  const owner = await findBusinessOwner(businessName)
  return Boolean(owner?.account?.premium)
}


// ---------- Blocked accounts ----------

const isBlockedEmail = async (email) => {
  if (!email) return false

  const account = await user.findOne(
    { email: clean(email).toLowerCase() },
    { projection: { status: 1 } }
  )

  return account?.status === "blocked"
}

const blockedResponse = (res) =>
  res.status(403).send({
    success: false,
    code: "ACCOUNT_BLOCKED",
    message: "Your account has been blocked by an administrator.",
  })



// Blocked accounts are refused inside verifyToken (every private route).


const getBlockedVendorEmails = async () => {
  const rows = await user
    .find({ role: "vendor", status: "blocked" }, { projection: { email: 1 } })
    .toArray()
  return rows.map((r) => String(r.email).toLowerCase())
}

// ---------- PROFILE HELPERS ----------

const getProfileByRole = async (email, expectedRole) => {
  const account = await user.findOne({ email })

  if (!account) {
    return {
      error: "Account not found",
      status: 404,
    }
  }

  const actualRole = account.role || "customer"

  const allowed =
    expectedRole === "customer"
      ? actualRole === "customer"
      : actualRole === "vendor"

  if (!allowed) {
    return {
      error: "You are not authorized to access this profile",
      status: 403,
    }
  }

  const collection =
    expectedRole === "vendor" ? vendorProfile : customerProfile

  const profileDoc = await collection.findOne({ email })

  const profile = {
    name: profileDoc?.name || account.name || "",
    email,
    role: actualRole,
    phone: profileDoc?.phone || "",
    address: profileDoc?.address || "",
    bio: profileDoc?.bio || "",
    image: profileDoc?.image || "",
    createdAt: profileDoc?.createdAt || account.createdAt,
  }

  if (expectedRole === "vendor") {
    profile.businessName = profileDoc?.businessName || ""
    profile.businessLocation = profileDoc?.businessLocation || ""
    profile.openingHours = profileDoc?.openingHours || ""
  }

  return { profile }
}



const updateProfileByRole = async (email, expectedRole, body) => {
  const account = await user.findOne({ email })

  if (!account) {
    return {
      error: "Account not found",
      status: 404,
    }
  }

  const actualRole = account.role || "customer"

  const allowed =
    expectedRole === "customer"
      ? actualRole === "customer"
      : actualRole === "vendor"

  if (!allowed) {
    return {
      error: "You are not authorized to update this profile",
      status: 403,
    }
  }

  // Personal information
  const name = clean(body.name)

  if (name.length < 2 || name.length > 60) {
    return {
      error: "Name must contain between 2 and 60 characters",
      status: 400,
    }
  }

  const updateDoc = {
    name,
    phone: clean(body.phone),
    address: clean(body.address),
    bio: clean(body.bio),
    image: clean(body.image),
    updatedAt: new Date(),
  }

  // Vendor-only information
  if (expectedRole === "vendor") {
    const businessName = clean(body.businessName)
    const businessLocation = clean(body.businessLocation)
    const openingHours = clean(body.openingHours)

    // Business name is required
    if (businessName.length < 2 || businessName.length > 80) {
      return {
        error: "Business name must contain between 2 and 80 characters",
        status: 400,
      }
    }

    // Location is optional
    if (
      businessLocation &&
      businessLocation.length > 120
    ) {
      return {
        error: "Business location cannot exceed 120 characters",
        status: 400,
      }
    }

    // Opening hours are optional
    if (
      openingHours &&
      openingHours.length > 80
    ) {
      return {
        error: "Opening hours cannot exceed 80 characters",
        status: 400,
      }
    }

    updateDoc.businessName = businessName
    updateDoc.businessLocation = businessLocation
    updateDoc.openingHours = openingHours
  }

  const collection =
    expectedRole === "vendor" ? vendorProfile : customerProfile

  await collection.updateOne(
    { email },
    {
      $set: updateDoc,
      $setOnInsert: {
        email,
        role: actualRole,
        createdAt: account.createdAt || new Date(),
      },
    },
    { upsert: true }
  )

  const updatedProfile = await collection.findOne({ email })

  return {
    profile: {
      ...updatedProfile,
      role: actualRole,
    },
  }
}

// ==================================================
// VENDOR PROFILE API
// ==================================================

// GET /vendor-profile/:email

app.get("/vendor-profile/:email", verifyToken, requireRole("vendor"), async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email)
      .trim()
      .toLowerCase()

    if (!ownsEmail(req, email)) return forbidden(res)

    const result = await getProfileByRole(email, "vendor")

    if (result.error) {
      return res.status(result.status).send({
        success: false,
        message: result.error,
      })
    }

    res.status(200).send(result.profile)
  } catch (error) {
    console.error("Get vendor profile error:", error)

    res.status(500).send({
      success: false,
      message: "Failed to load vendor profile",
    })
  }
})


// PUT /vendor-profile/:email


app.put("/vendor-profile/:email", verifyToken, requireRole("vendor"), async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email)
      .trim()
      .toLowerCase()

    // A vendor can only change their own profile
    if (!ownsEmail(req, email)) return forbidden(res)

    const result = await updateProfileByRole(
      email,
      "vendor",
      req.body
    )

    if (result.error) {
      return res.status(result.status).send({
        success: false,
        message: result.error,
      })
    }

    return res.status(200).send({
      success: true,
      message: "Vendor profile updated successfully",
      ...result.profile,
    })
  } catch (error) {
    console.error("Update vendor profile error:", error)

    return res.status(500).send({
      success: false,
      message: "Failed to update vendor profile",
    })
  }
})


// ==================================================
// CUSTOMER PROFILE API
// ==================================================

// GET /customer-profile/:email

app.get("/customer-profile/:email", verifyToken, requireRole("customer"), async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email)
      .trim()
      .toLowerCase()

    if (!ownsEmail(req, email)) return forbidden(res)

    const result = await getProfileByRole(email, "customer")

    if (result.error) {
      return res.status(result.status).send({
        success: false,
        message: result.error,
      })
    }

    res.status(200).send(result.profile)
  } catch (error) {
    console.error("Get customer profile error:", error)

    res.status(500).send({
      success: false,
      message: "Failed to load customer profile",
    })
  }
})


// PUT /customer-profile/:email

app.put("/customer-profile/:email", verifyToken, requireRole("customer"), async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email)
      .trim()
      .toLowerCase()

    if (!ownsEmail(req, email)) return forbidden(res)

    const result = await updateProfileByRole(
      email,
      "customer",
      req.body
    )

    if (result.error) {
      return res.status(result.status).send({
        success: false,
        message: result.error,
      })
    }

    res.status(200).send({
      success: true,
      message: "Customer profile updated successfully",
      ...result.profile,
    })
  } catch (error) {
    console.error("Update customer profile error:", error)

    res.status(500).send({
      success: false,
      message: "Failed to update customer profile",
    })
  }
})

// ---------- Subscription ----------

// successful Stripe payment. Only a boolean is returned.
app.get("/subscription/:email", verifyToken, requireRole("vendor"), async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).trim().toLowerCase()

    if (!ownsEmail(req, email)) return forbidden(res)

    const account = await user.findOne(
      { email },
      { projection: { premium: 1 } }
    )

    if (!account) {

      return res.status(404).send({
        success: false,
        message: "Account not found",
      })
    }

    res.status(200).send({
      email,
      premium: Boolean(account.premium),
      plan: account.premium ? "Premium" : "Free",
      activeItemLimit: account.premium ? null : FREE_ACTIVE_ITEM_LIMIT,
    })
  } catch (error) {
    console.error("Get subscription error:", error)
    res.status(500).send({
      success: false,
      message: "Failed to load subscription",
    })
  }
})

app.put("/profile/:email", verifyToken, requireRole("vendor", "customer"), async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).trim().toLowerCase()

    if (!ownsEmail(req, email)) return forbidden(res)

    const {
      name,
      phone,
      address,
      bio,
      image,
      businessName,
      businessLocation,
      openingHours,
    } = req.body

    if (!name || name.trim().length < 2) {
      return res.status(400).send({
        success: false,
        message: "Name must contain at least 2 characters",
      })
    }

    const account = await user.findOne({ email })

    if (!account) {
      return res.status(404).send({
        success: false,
        message: "User not found",
      })
    }

    const role = account.role || "customer"
    if (role === "admin") {
      return res.status(403).send({
        success: false,
        message: "Admins do not have a profile",
      })
    }
    const isVendor = role === "vendor"

    // if (isVendor) {
    //   if (
    //     !clean(businessName) ||
    //     !clean(businessLocation) ||
    //     !clean(openingHours)
    //   ) {
    //     return res.status(400).send({
    //       success: false,
    //       message:
    //         "Business name, business location and opening hours are required for vendors",
    //     })
    //   }
    // }
    if (isVendor && !clean(businessName)) {
      return res.status(400).send({
        success: false,
        message: "Business name is required for vendors",
      })
    }
    const updateDoc = {
      name: name.trim(),
      phone: phone?.trim() || "",
      address: address?.trim() || "",
      bio: bio?.trim() || "",
      image: image?.trim() || "",
      updatedAt: new Date(),
    }

    // Restaurant details are saved only in the vendor profile collection
    if (isVendor) {
      updateDoc.businessName = businessName.trim()
      updateDoc.businessLocation = businessLocation.trim()
      updateDoc.openingHours = openingHours.trim()
    }

    const collection = profileCollectionFor(role)

    await collection.updateOne(
      { email },
      {
        $set: updateDoc,
        $setOnInsert: {
          email,
          role,
          createdAt: account.createdAt || new Date(),
        },
      },
      { upsert: true }
    )

    const updatedProfile = await collection.findOne({ email })

    res.status(200).send({
      success: true,
      message: "Profile updated successfully",
      ...updatedProfile,
    })
  } catch (error) {
    console.error("Update profile error:", error)
    res.status(500).send({
      success: false,
      message: "Failed to update profile",
    })
  }
})


app.get("/menu", verifyToken, requireRole("vendor", "admin"), async (req, res) => {
  try {
    const query = {}

    // Vendors only ever see their own dishes; admins see everything
    if (req.user.role === "vendor") {
      const own = clean(req.user.email).toLowerCase()
      query.$or = [{ vendorEmail: own }, { email: own }]
    }

    const approvalStatus = clean(req.query.approvalStatus)

    // Default: show only approved items
    if (approvalStatus && approvalStatus !== "all") {
      query.approvalStatus = approvalStatus
    } else if (approvalStatus !== "all") {
      query.approvalStatus = "approved"
    }

    const name = clean(req.query.name)
    const category = clean(req.query.category)
    const location = clean(req.query.location)
    const businessName = clean(req.query.businessName)

    if (name) {
      query.$and = name.split(/\s+/).map((word) => ({
        name: { $regex: escapeRegex(word), $options: "i" },
      }))
    }

    if (category) {
      query.category = {
        $regex: `^${escapeRegex(category)}$`,
        $options: "i",
      }
    }

    if (location) {
      query.location = {
        $regex: escapeRegex(location),
        $options: "i",
      }
    }

    if (businessName) {
      query.businessName = {
        $regex: `^${escapeRegex(businessName)}$`,
        $options: "i",
      }
    }

    const result = await menu.find(query).limit(200).toArray()

    res.status(200).send(result)
  } catch (error) {
    console.error("Failed to fetch menu:", error)
    res.status(500).send({
      success: false,
      message: "Failed to fetch menu items",
    })
  }
})


app.post("/menu", verifyToken, requireRole("vendor"), async (req, res) => {
  try {
    const {
      email,
      name,
      category,
      description,
      price,
      location,
      image,
      businessName,
    } = req.body || {}

    // 1. Validate vendor email
    // The vendor is the signed-in account - never the email sent by the browser
    const vendorEmail = clean(req.user.email).toLowerCase()

    if (!vendorEmail) {
      return res.status(400).send({
        success: false,
        message: "Vendor email is required.",
      })
    }

    // 2. Check that this account is a vendor
    const account = await user.findOne({ email: vendorEmail })

    if (!account || account.role !== "vendor") {
      return res.status(403).send({
        success: false,
        message: "Only vendors can add menu items.",
      })
    }

    // 3. Get the actual business name from MongoDB profile
    const vendorProfileDoc = await vendorProfile.findOne({
      email: vendorEmail,
    })

    const profileBusinessName = clean(
      vendorProfileDoc?.businessName
    )

    if (!profileBusinessName) {
      return res.status(400).send({
        success: false,
        message: "Please add your business name in your profile first.",
      })
    }

    // 4. Compare frontend business name with profile business name
    const submittedBusinessName = clean(businessName)

    if (
      !submittedBusinessName ||
      submittedBusinessName.toLowerCase() !==
      profileBusinessName.toLowerCase()
    ) {
      return res.status(409).send({
        success: false,
        message:
          "Business name does not match your vendor profile. Please refresh and try again.",
      })
    }

    // 5. Validate menu item fields
    const itemName = clean(name)
    const itemCategory = clean(category)
    const itemDescription = clean(description)
    const itemLocation = clean(location)
    const itemImage = clean(image)
    const itemPrice = Number(price)

    if (itemName.length < 3) {
      return res.status(400).send({
        success: false,
        message: "Item name must contain at least 3 characters.",
      })
    }

    if (!itemCategory) {
      return res.status(400).send({
        success: false,
        message: "Category is required.",
      })
    }

    if (!itemDescription) {
      return res.status(400).send({
        success: false,
        message: "Description is required.",
      })
    }

    if (!Number.isFinite(itemPrice) || itemPrice <= 0) {
      return res.status(400).send({
        success: false,
        message: "Price must be greater than 0.",
      })
    }

    if (!itemLocation) {
      return res.status(400).send({
        success: false,
        message: "Location is required.",
      })
    }

    if (!/^https?:\/\/\S+$/i.test(itemImage)) {
      return res.status(400).send({
        success: false,
        message: "A valid item image URL is required.",
      })
    }

    // 6. Save the business name FROM THE PROFILE, not the frontend
    const menuData = {
      name: itemName,
      category: itemCategory,
      description: itemDescription,
      price: itemPrice,
      businessName: profileBusinessName,
      vendorEmail,
      email: vendorEmail,
      location: itemLocation,
      image: itemImage,
      approvalStatus: "pending",
      isAvailable: false,
      createdAt: new Date(),
    }

    const result = await menu.insertOne(menuData)

    res.status(201).send({
      success: true,
      message: "Menu item added successfully!",
      insertedId: result.insertedId,
      menu: menuData,
    })
  } catch (error) {
    console.error("Menu creation error:", error)

    res.status(500).send({
      success: false,
      message: "Failed to add menu item.",
    })
  }
})





// app.patch(
//   "/menu/:id/moderation",
//   verifyToken,
//   requireRole("admin"),
//   async (req, res) => {
//     try {
//       const { id } = req.params
//       const approvalStatus = clean(req.body?.approvalStatus)

//       // Validate item ID
//       if (!ObjectId.isValid(id)) {
//         return res.status(400).send({
//           success: false,
//           message: "Invalid menu item ID",
//         })
//       }

//       // Only these two moderation actions are allowed
//       if (!["approved", "pending"].includes(approvalStatus)) {
//         return res.status(400).send({
//           success: false,
//           message: "Status must be approved or pending",
//         })
//       }

//       // Find the menu item
//       const item = await menu.findOne({
//         _id: new ObjectId(id),
//       })

//       if (!item) {
//         return res.status(404).send({
//           success: false,
//           message: "Menu item not found",
//         })
//       }

//       let isAvailable = false
//       let activeItems = 0
//       let limit = FREE_ACTIVE_ITEM_LIMIT
//       let message = ""

//       if (approvalStatus === "approved") {
//         const vendorEmail = clean(
//           item.vendorEmail || item.email
//         ).toLowerCase()

//         if (!vendorEmail) {
//           return res.status(400).send({
//             success: false,
//             message: "Vendor email is missing",
//           })
//         }

//         // Find the vendor account
//         const vendorAccount = await user.findOne({
//           email: vendorEmail,
//           role: "vendor",
//         })

//         if (!vendorAccount) {
//           return res.status(404).send({
//             success: false,
//             message: "Vendor account not found",
//           })
//         }

//         // Do not approve items belonging to blocked vendors
//         if (vendorAccount.status === "blocked") {
//           return res.status(403).send({
//             success: false,
//             code: "ACCOUNT_BLOCKED",
//             message: "This vendor account is blocked",
//           })
//         }

//         const isPremium = Boolean(vendorAccount.premium)

//         if (isPremium) {
//           // Premium vendors have no active-item limit
//           isAvailable = true
//           limit = null
//           message = "Menu item approved and activated successfully!"
//         } else {
//           // Count the vendor's OTHER active and approved items
//           activeItems = await menu.countDocuments({
//             $and: [
//               {
//                 $or: [
//                   { vendorEmail },
//                   { email: vendorEmail },
//                 ],
//               },
//               {
//                 approvalStatus: "approved",
//                 isAvailable: true,
//               },
//               {
//                 _id: { $ne: item._id },
//               },
//             ],
//           })

//           // Admin approval is always allowed.
//           // The limit only controls whether the item becomes active.
//           if (activeItems < FREE_ACTIVE_ITEM_LIMIT) {
//             isAvailable = true
//             message = "Menu item approved and activated successfully!"
//           } else {
//             isAvailable = false

//             message =
//               `Menu item approved successfully, but this vendor already has ` +
//               `${activeItems} active items. The item remains unavailable. ` +
//               `Free vendors can publish only ${FREE_ACTIVE_ITEM_LIMIT} active items.`
//           }
//         }
//       } else {
//         // Hiding an item makes it unavailable
//         isAvailable = false
//         message = "Menu item hidden from customers."
//       }

//       // Save the moderation result
//       await menu.updateOne(
//         { _id: item._id },
//         {
//           $set: {
//             approvalStatus,
//             isAvailable,
//             reviewedAt: new Date(),
//             updatedAt: new Date(),
//           },
//         }
//       )

//       // Get the updated item
//       const updatedItem = await menu.findOne({
//         _id: item._id,
//       })

//       return res.status(200).send({
//         success: true,
//         message,
//         approvalStatus: updatedItem.approvalStatus,
//         isAvailable: updatedItem.isAvailable,
//         activeItems,
//         limit,
//         menu: updatedItem,
//       })
//     } catch (error) {
//       console.error("Moderation error:", error)

//       return res.status(500).send({
//         success: false,
//         message: "Failed to update approval status",
//       })
//     }
//   }
// )



app.patch(
  "/menu/:id/moderation",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { id } = req.params
      const approvalStatus = clean(req.body?.approvalStatus)

      // Validate item ID
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          success: false,
          message: "Invalid menu item ID",
        })
      }

      // Only these two moderation actions are allowed
      if (!["approved", "pending"].includes(approvalStatus)) {
        return res.status(400).send({
          success: false,
          message: "Status must be approved or pending",
        })
      }

      // Find the menu item
      const item = await menu.findOne({
        _id: new ObjectId(id),
      })

      if (!item) {
        return res.status(404).send({
          success: false,
          message: "Menu item not found",
        })
      }

      let isAvailable = false
      let activeItems = 0
      let limit = FREE_ACTIVE_ITEM_LIMIT
      let message = ""
      // true = approved, but waiting for the vendor to subscribe to Premium
      let blockedByLimit = false

      if (approvalStatus === "approved") {
        const vendorEmail = clean(
          item.vendorEmail || item.email
        ).toLowerCase()

        if (!vendorEmail) {
          return res.status(400).send({
            success: false,
            message: "Vendor email is missing",
          })
        }

        // Find the vendor account
        const vendorAccount = await user.findOne({
          email: vendorEmail,
          role: "vendor",
        })

        if (!vendorAccount) {
          return res.status(404).send({
            success: false,
            message: "Vendor account not found",
          })
        }

        // Do not approve items belonging to blocked vendors
        if (vendorAccount.status === "blocked") {
          return res.status(403).send({
            success: false,
            code: "ACCOUNT_BLOCKED",
            message: "This vendor account is blocked",
          })
        }

        const isPremium = Boolean(vendorAccount.premium)

        if (isPremium) {
          // Premium vendors have no active-item limit
          isAvailable = true
          limit = null
          message = "Menu item approved and activated successfully!"
        } else {
          // Count the vendor's OTHER active and approved items
          activeItems = await menu.countDocuments({
            $and: [
              {
                $or: [
                  { vendorEmail },
                  { email: vendorEmail },
                ],
              },
              {
                approvalStatus: "approved",
                isAvailable: true,
              },
              {
                _id: { $ne: item._id },
              },
            ],
          })

          // Admin approval is always allowed.
          // The limit only controls whether the item becomes active.
          if (activeItems < FREE_ACTIVE_ITEM_LIMIT) {
            isAvailable = true
            message = "Menu item approved and activated successfully!"
          } else {
            // 4th item or more on a free plan: stays inactive until the
            // vendor subscribes (checkout-verify activates flagged items)
            isAvailable = false
            blockedByLimit = true
            message =
              "Sorry, this vendor needs a Premium subscription to activate more than " +
              `${FREE_ACTIVE_ITEM_LIMIT} items.`
          }
        }
      } else {
        // Hiding an item makes it unavailable
        isAvailable = false
        message = "Menu item hidden from customers."
      }

      // Save the moderation result
      await menu.updateOne(
        { _id: item._id },
        {
          $set: {
            approvalStatus,
            isAvailable,
            pendingActivation: blockedByLimit,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          },
        }
      )

      // Get the updated item
      const updatedItem = await menu.findOne({
        _id: item._id,
      })

      return res.status(200).send({
        success: true,
        message,
        activated: updatedItem.isAvailable,
        code: blockedByLimit ? "PREMIUM_REQUIRED" : undefined,
        approvalStatus: updatedItem.approvalStatus,
        isAvailable: updatedItem.isAvailable,
        activeItems,
        limit,
        menu: updatedItem,
      })
    } catch (error) {
      console.error("Moderation error:", error)

      return res.status(500).send({
        success: false,
        message: "Failed to update approval status",
      })
    }
  }
)

app.patch(
  "/menu/:id/availability",
  verifyToken,
  requireRole("admin","vendor"),
  async (req, res) => {
    try {
      const { id } = req.params

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ success: false, message: "Invalid menu item ID" })
      }

      if (typeof req.body?.isAvailable !== "boolean") {
        return res.status(400).send({ success: false, message: "isAvailable must be true or false" })
      }

      const item = await menu.findOne({ _id: new ObjectId(id) })

      if (!item) {
        return res.status(404).send({ success: false, message: "Menu item not found" })
      }
      if (!isOwnerOrAdmin(req, item.vendorEmail || item.email)) {
        return forbidden(res, "This is not your dish")
      }
      if (item.approvalStatus !== "approved") {
        return res.status(409).send({
          success: false,
          message: "Only approved items can be activated or deactivated.",
        })
      }

      // Deactivate: always allowed. Clear the flag so a later subscription
      // does not switch this item back on.
      if (req.body.isAvailable === false) {
        await menu.updateOne(
          { _id: item._id },
          { $set: { isAvailable: false, pendingActivation: false, updatedAt: new Date() } }
        )
        return res.status(200).send({ success: true, isAvailable: false })
      }

      // Activate: check the vendor and the free limit
      const vendorEmail = clean(item.vendorEmail || item.email).toLowerCase()

      const vendorAccount = await user.findOne({ email: vendorEmail, role: "vendor" })

      if (!vendorAccount) {
        return res.status(404).send({ success: false, message: "Vendor account not found" })
      }

      if (vendorAccount.status === "blocked") {
        return res.status(403).send({
          success: false,
          code: "ACCOUNT_BLOCKED",
          message: "This vendor account is blocked",
        })
      }

      if (!vendorAccount.premium) {
        const activeItems = await menu.countDocuments({
          $and: [
            { $or: [{ vendorEmail }, { email: vendorEmail }] },
            { approvalStatus: "approved", isAvailable: true },
            { _id: { $ne: item._id } },
          ],
        })

        if (activeItems >= FREE_ACTIVE_ITEM_LIMIT) {
          // Remember it, so subscribing activates this item automatically
          await menu.updateOne(
            { _id: item._id },
            { $set: { pendingActivation: true, updatedAt: new Date() } }
          )

          return res.status(403).send({
            success: false,
            code: "PREMIUM_REQUIRED",
                        message:
              req.user.role === "vendor"
                ? `The Free plan allows only ${FREE_ACTIVE_ITEM_LIMIT} active items. Upgrade to Premium to activate more.`
                : `Sorry, this vendor needs a Premium subscription to activate more than ${FREE_ACTIVE_ITEM_LIMIT} items.`,
          })
        }
      }

      await menu.updateOne(
        { _id: item._id },
        { $set: { isAvailable: true, pendingActivation: false, updatedAt: new Date() } }
      )

      return res.status(200).send({ success: true, isAvailable: true })
    } catch (error) {
      console.error("Availability error:", error)
      return res.status(500).send({ success: false, message: "Failed to update availability" })
    }
  }
)

app.put("/menu/:id", verifyToken, requireRole("vendor", "admin"), async (req, res) => {
  try {
    const { id } = req.params
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid item id" })
    }

    // Only the owner (or an admin) may edit a dish
    const existing = await menu.findOne({ _id: new ObjectId(id) })
    if (!existing) {
      return res.status(404).send({ message: "Menu item not found" })
    }
    if (!isOwnerOrAdmin(req, existing.vendorEmail || existing.email)) {
      return forbidden(res, "This is not your dish")
    }

    const { name, price, location, description } = req.body || {}

    if (
      !name || name.trim().length < 3 ||
      !location?.trim() ||
      !description?.trim() ||
      !Number.isFinite(Number(price)) || Number(price) <= 0
    ) {
      return res.status(400).send({ message: "Invalid data" })
    }

    // Only whitelisted fields can be changed
    const result = await menu.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          name: name.trim(),
          price: Number(price),
          location: location.trim(),
          description: description.trim(),
          updatedAt: new Date(),
        },
      }
    )

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "Menu item not found" })
    }

    res.send({ message: "Menu item updated", modifiedCount: result.modifiedCount })
  } catch (error) {
    console.error(error)
    res.status(500).send({ message: "Server error" })
  }
})

app.delete("/menu/:id", verifyToken, requireRole("vendor", "admin"), async (req, res) => {
  try {
    const { id } = req.params
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid item id" })
    }

    // Only the owner (or an admin) may delete a dish
    const existing = await menu.findOne({ _id: new ObjectId(id) })
    if (!existing) {
      return res.status(404).send({ message: "Menu item not found" })
    }
    if (!isOwnerOrAdmin(req, existing.vendorEmail || existing.email)) {
      return forbidden(res, "This is not your dish")
    }

    const result = await menu.deleteOne({ _id: new ObjectId(id) })

    if (result.deletedCount === 0) {
      return res.status(404).send({ message: "Menu item not found" })
    }

    res.send({ message: "Menu item deleted", deletedCount: result.deletedCount })
  } catch (error) {
    console.error(error)
    res.status(500).send({ message: "Server error" })
  }
})






// ---------- Orders ----------

// My orders page: /orders?email=x@y.com
app.get('/orders', verifyToken, requireRole('customer'), async (req, res) => {
  try {
    // My orders: always the signed-in customer's own orders
    const email = clean(req.user.email).toLowerCase()

    const result = await orders.find({ 'customer.email': email }).sort({ createdAt: -1 }).limit(200).toArray()
    res.send(result)
  } catch (error) {
    console.error('Failed to fetch orders:', error)
    res.status(500).send({ success: false, message: 'Failed to fetch orders' })
  }
})

// ---------- PATCH /orders/
app.patch('/orders/:id/cancel', verifyToken, requireRole('customer'), async (req, res) => {
  try {
    const { id } = req.params
    const email = clean(req.user.email).toLowerCase()

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ success: false, message: 'Invalid order id' })
    }
    if (!email) {
      return res.status(400).send({ success: false, message: 'Customer email is required' })
    }

    // Someone else's order looks exactly like a missing order
    const order = await orders.findOne({ _id: new ObjectId(id), 'customer.email': email })
    if (!order) {
      return res.status(404).send({ success: false, message: 'Order not found' })
    }

    if (order.status !== 'pending') {
      return res.status(409).send({
        success: false,
        message: `This order is already ${order.status} and can no longer be cancelled.`,
      })
    }

    // The status is checked again inside the update, so an order the vendor
    // accepts at the same moment cannot be cancelled by mistake.
    const result = await orders.updateOne(
      { _id: order._id, 'customer.email': email, status: 'pending' },
      { $set: { status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date() } }
    )

    if (result.modifiedCount === 0) {
      return res.status(409).send({
        success: false,
        message: 'This order can no longer be cancelled.',
      })
    }

    res.send({ success: true, status: 'cancelled' })
  } catch (error) {
    console.error('Cancel order failed:', error)
    res.status(500).send({ success: false, message: 'Failed to cancel order' })
  }
})

// ---------- Payments ----------

app.post('/payments/checkout-verify', verifyToken, requireRole('vendor'), async (req, res) => {
  try {
    const sessionId = clean(req.body?.sessionId)

    if (!sessionId) {
      return res.status(400).send({
        success: false,
        message: 'sessionId is required',
      })
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId)
    const {
      status,
      payment_status,
      customer,
      customer_email,
      metadata,
      subscription,
      amount_total,
      currency,
    } = session

    if (status !== 'complete' || payment_status !== 'paid') {
      return res.status(400).send({
        success: false,
        message: 'Payment is not complete',
      })
    }

    const userId = clean(metadata?.userId)
    if (!userId) {
      return res.status(400).send({
        success: false,
        message: 'No user on this payment',
      })
    }

    // The payment must belong to the signed-in vendor
    if (userId !== String(req.user._id) && userId !== String(req.user.id || '')) {
      return forbidden(res, 'This payment does not belong to your account')
    }

    // A page refresh must not save the same transaction twice
    const existing = await transactions.findOne({ sessionId })
    if (existing) {
      return res.send({
        success: true,
        alreadyProcessed: true,
        transaction: existing,
      })
    }

    // Vendor details: the account that paid -> its vendor profile
    const accountQuery = ObjectId.isValid(userId)
      ? { _id: new ObjectId(userId) }
      : { id: userId }

    const account = await user.findOne(accountQuery)
    const email = (account?.email || customer_email || '').toLowerCase()
    const profileDoc = email ? await vendorProfile.findOne({ email }) : null

    const vendorName =
      profileDoc?.businessName || account?.name || email || 'Vendor'

    const transaction = {
      sessionId,
      userId,
      vendorName,
      vendorEmail: email,
      plan: 'Premium',
      premium: true,
      amount:
        typeof amount_total === 'number'
          ? Number((amount_total / 100).toFixed(2))
          : 0,
      currency: (currency || 'usd').toUpperCase(),
      status,
      payment_status,
      stripeCustomerId:
        typeof customer === 'string' ? customer : customer?.id || null,
      subscriptionId:
        typeof subscription === 'string' ? subscription : subscription?.id || null,
      payment_date: new Date(),
      createdAt: new Date(),
    }

    const result = await transactions.insertOne(transaction)
    // Upgrade the account only after Stripe confirmed the payment
    // if (account) {
    //   await user.updateOne(accountQuery, {
    //     $set: { premium: true, plan: 'premium', updatedAt: new Date() },
    //   })
    // }

        // Upgrade the account only after Stripe confirmed the payment
    if (account) {
      await user.updateOne(accountQuery, {
        $set: { premium: true, plan: 'premium', updatedAt: new Date() },
      })

      // Activate the items that were approved but blocked by the free limit
      const vendorEmail = clean(account.email).toLowerCase()
      await menu.updateMany(
        {
          $or: [{ vendorEmail }, { email: vendorEmail }],
          approvalStatus: 'approved',
          pendingActivation: true,
        },
        {
          $set: { isAvailable: true, pendingActivation: false, updatedAt: new Date() },
        }
      )
    }
    res.send({
      success: true,
      insertedId: result.insertedId,
      transaction: { ...transaction, _id: result.insertedId },
    })
  } catch (error) {
    console.error('Checkout verify failed:', error)
    res.status(500).send({
      success: false,
      message: error?.message || 'payment verification failed'
    })
  }
})

// ---------- POST /orders ----------
// Saves ONE order per kitchen, so every order belongs to exactly one vendor
// and a vendor can never touch another vendor's food.
app.post('/orders', verifyToken, requireRole('customer'), async (req, res) => {
  try {
    // console.log('headers on the server',req.headers)
    const { customer, items, delivery, paymentMethod } = req.body || {}

    // The customer is the signed-in account - never the email sent by the browser
    const email = clean(req.user.email).toLowerCase()
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).send({ success: false, message: 'Order has no items' })
    }

    // Delivery details are required by the order form
    const deliveryDate = clean(delivery?.date)
    const deliveryAddress = clean(delivery?.address)

    if (!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) {
      return res.status(400).send({
        success: false,
        message: 'Please choose a valid delivery date.',
      })
    }

    const today = new Date()
    const pad = (value) => String(value).padStart(2, '0')
    const todayString = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`

    if (deliveryDate < todayString) {
      return res.status(400).send({
        success: false,
        message: 'The delivery date cannot be in the past.',
      })
    }

    if (deliveryAddress.length < 5) {
      return res.status(400).send({
        success: false,
        message: 'Please add a complete delivery address.',
      })
    }

    // Prices, images and kitchen names come from the database, not the browser.
    // Only dishes that are approved AND published can be ordered.
    const ids = items.map((i) => clean(i.menuId)).filter((id) => ObjectId.isValid(id))
    const dishes = await menu
      .find({
        _id: { $in: ids.map((id) => new ObjectId(id)) },
        approvalStatus: 'approved',
        isAvailable: true,
      })
      .toArray()
    const byId = new Map(dishes.map((d) => [String(d._id), d]))

    const orderItems = []
    for (const i of items) {
      const dish = byId.get(clean(i.menuId))
      const quantity = Math.floor(Number(i.quantity))
      if (!dish || !Number.isFinite(quantity) || quantity < 1 || quantity > 20) {
        return res.status(400).send({ success: false, message: 'Invalid item in order' })
      }
      orderItems.push({
        menuId: String(dish._id),
        name: dish.name,
        category: dish.category,
        image: dish.image || '',
        price: Number(dish.price),
        quantity,
        businessName: dish.businessName,
        lineTotal: Number(dish.price) * quantity,
      })
    }


    const customerAccount = await user.findOne({ email })
    if (!customerAccount || customerAccount.role !== 'customer') {
      return res.status(403).send({
        success: false,
        message: 'Only customers can place orders',
      })
    }

    // The same item cannot have two active orders for the same delivery date
    const activeStatuses = ['pending', 'accepted']
    const menuIds = [...new Set(orderItems.map((item) => item.menuId))]

    const duplicate = await orders.findOne({
      'customer.email': email,
      status: { $in: activeStatuses },
      'delivery.date': deliveryDate,
      'items.menuId': { $in: menuIds },
    })

    if (duplicate) {
      return res.status(409).send({
        success: false,
        code: 'DUPLICATE_ORDER',
        message: `You already have an active order for this item on ${deliveryDate}.`,
      })
    }

    // Group the items by kitchen
    const groups = new Map()
    for (const item of orderItems) {
      const key = clean(item.businessName).toLowerCase()
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(item)
    }

    // Fill in phone and name from the customer's profile when missing
    const customerDoc = await customerProfile.findOne({ email })

    const checkoutId = new ObjectId().toHexString() // links orders from one checkout
    const now = new Date()
    const docs = []
    let first = true

    for (const [vendorKey, vendorItems] of groups) {
      const subtotal = vendorItems.reduce((s, i) => s + i.lineTotal, 0)
      // Delivery fee and discount are charged once per checkout (first order),
      // so the total still matches the amount shown on the payment page.
      const deliveryFee = first ? 60 : 0
      const discount = first ? 50 : 0
      first = false

      docs.push({
        checkoutId,
        vendorKey,
        businessName: vendorItems[0].businessName,
        customer: {
          id: String(req.user._id),
          name: clean(customer?.name) || customerDoc?.name || '',
          email,
          phone: clean(customer?.phone) || customerDoc?.phone || '',
        },
        items: vendorItems,
        delivery: {
          address: deliveryAddress,
          date: deliveryDate,
          note: clean(delivery?.note),
        },
        paymentMethod: clean(paymentMethod) || 'cod',
        subtotal,
        deliveryFee,
        discount,
        total: subtotal + deliveryFee - discount,
        status: 'pending',
        createdAt: now,
      })
    }

    const result = await orders.insertMany(docs)
    res.status(201).send({
      success: true,
      count: docs.length,
      insertedIds: Object.values(result.insertedIds),
    })
  } catch (error) {
    console.error('Order creation failed:', error)
    res.status(500).send({ success: false, message: 'Failed to place order' })
  }
})

// ---------- Vendor orders ----------

// Which kitchen does this vendor account run? (user role -> vendorProfile.businessName)
async function getVendorBusiness(email) {
  const account = await user.findOne({ email })
  if (!account || account.role !== 'vendor') {
    return { error: 'Only vendors can do this', status: 403 }
  }

  const profileDoc = await vendorProfile.findOne({ email })
  const businessName = clean(profileDoc?.businessName)
  if (!businessName) {
    return { error: 'Add your business name in Profile settings first', status: 403 }
  }
  return { businessName, vendorKey: businessName.toLowerCase() }
}

// Vendor's customer orders: /vendor/orders?email=vendor@x.com
app.get('/vendor/orders', verifyToken, requireRole('vendor'), async (req, res) => {
  try {
    const email = clean(req.user.email).toLowerCase()

    const vendor = await getVendorBusiness(email)
    if (vendor.error) return res.status(vendor.status).send({ success: false, message: vendor.error })

    const result = await orders
      .find({ vendorKey: vendor.vendorKey })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray()

    res.send({ success: true, businessName: vendor.businessName, orders: result })
  } catch (error) {
    console.error('Failed to fetch vendor orders:', error)
    res.status(500).send({ success: false, message: 'Failed to fetch orders' })
  }
})

// Accept or reject: PATCH /orders/:id/status  { email, status: "accepted" | "rejected" }
app.patch('/orders/:id/status', verifyToken, requireRole('vendor'), async (req, res) => {
  try {
    const { id } = req.params
    const email = clean(req.user.email).toLowerCase()
    const status = clean(req.body?.status)

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ success: false, message: 'Invalid order id' })
    }
    if (!['accepted', 'rejected'].includes(status)) {
      return res.status(400).send({ success: false, message: 'Status must be accepted or rejected' })
    }
    if (!email) {
      return res.status(400).send({ success: false, message: 'Vendor email is required' })
    }

    const vendor = await getVendorBusiness(email)
    if (vendor.error) return res.status(vendor.status).send({ success: false, message: vendor.error })

    // Another vendor's order looks exactly like a missing order
    const order = await orders.findOne({ _id: new ObjectId(id), vendorKey: vendor.vendorKey })
    if (!order) return res.status(404).send({ success: false, message: 'Order not found' })

    if (order.status !== 'pending') {
      return res.status(409).send({
        success: false,
        message: `This order is already ${order.status}. Only pending orders can be accepted or rejected.`,
      })
    }

    // Status is checked again inside the update: the decision can only happen once,
    // even if the customer cancels or the vendor double-clicks at the same moment.
    const result = await orders.updateOne(
      { _id: order._id, vendorKey: vendor.vendorKey, status: 'pending' },
      { $set: { status, decidedAt: new Date(), updatedAt: new Date() } }
    )

    if (result.modifiedCount === 0) {
      return res.status(409).send({ success: false, message: 'This order is no longer pending.' })
    }

    res.send({ success: true, status })
  } catch (error) {
    console.error('Update order status failed:', error)
    res.status(500).send({ success: false, message: 'Failed to update order' })
  }
})

// ---------- GET /transactions ----------

app.get('/transactions', verifyToken, requireRole('admin', 'vendor'), async (req, res) => {
  try {
    const query = {}

    const userId = clean(req.query.userId)
    const paymentStatus = clean(req.query.paymentStatus)

    if (req.user.role === 'vendor') {
      // A vendor only ever sees their own payments
      query.vendorEmail = clean(req.user.email).toLowerCase()
    } else {
      const vendorEmail = clean(req.query.vendorEmail)
      if (vendorEmail) {
        query.vendorEmail = {
          $regex: `^${escapeRegex(vendorEmail)}$`,
          $options: 'i',
        }
      }
    }

    if (userId) {
      query.userId = userId
    }

    if (paymentStatus) {
      query.payment_status = paymentStatus
    }

    const result = await transactions
      .find(query)
      .sort({ payment_date: -1 })
      .limit(200)
      .toArray()

    res.status(200).send(result)
  } catch (error) {
    console.error('Failed to fetch transactions:', error)
    res.status(500).send({
      success: false,
      message: 'Failed to fetch transactions',
    })
  }
})

// ---------- GET /admin/stats ----------
// Dashboard numbers for the admin overview. The admin email is checked
// against the user collection so ordinary accounts cannot read these counts.
//   /admin/stats?email=admin@example.com
app.get('/admin/stats', verifyToken, requireRole('admin'), async (req, res) => {
  try {

    const [
      totalUsers,
      totalVendors,
      totalCustomers,
      totalMenuItems,
      pendingMenuItems,
      totalTransactions,
    ] = await Promise.all([
      user.countDocuments({}),
      user.countDocuments({ role: 'vendor' }),
      user.countDocuments({ role: 'customer' }),
      menu.countDocuments({}),
      menu.countDocuments({ approvalStatus: 'pending' }),
      transactions.countDocuments({}),
    ])

    res.status(200).send({
      totalUsers,
      totalVendors,
      totalCustomers,
      totalMenuItems,
      pendingMenuItems,
      totalTransactions,
    })
  } catch (error) {
    console.error('Failed to load admin stats:', error)
    res.status(500).send({
      success: false,
      message: 'Failed to load admin statistics',
    })
  }
})

// ---------- GET /browse-menu ----------

app.get("/browse-menu", async (req, res) => {
  try {
    // Public endpoint: only approved dishes are ever returned
    // const query = { approvalStatus: "approved" }
    const query = {
      approvalStatus: "approved",
      isAvailable: true,
    }
    const name = clean(req.query.name)
    const category = clean(req.query.category)
    const location = clean(req.query.location)
    const businessName = clean(req.query.businessName)

    // Every word typed must appear in the dish name, in any order
    // "smoky supreme" matches "Smoky Pepperoni Supreme"
    if (name) {
      query.$and = name
        .split(/\s+/)
        .map((word) => ({
          name: { $regex: escapeRegex(word), $options: "i" },
        }))
    }

    // Exact category, case-insensitive
    if (category) {
      query.category = { $regex: `^${escapeRegex(category)}$`, $options: "i" }
    }

    // Partial location match, case-insensitive
    if (location) {
      query.location = { $regex: escapeRegex(location), $options: "i" }
    }

    // Exact business match, case-insensitive
    if (businessName) {
      query.businessName = {
        $regex: `^${escapeRegex(businessName)}$`,
        $options: "i",
      }
    }
    // Dishes of blocked vendors are never public
    const blockedVendors = await getBlockedVendorEmails()
    if (blockedVendors.length) query.vendorEmail = { $nin: blockedVendors }

    const search = clean(req.query.search)

    if (search) {
      const regex = { $regex: escapeRegex(search), $options: "i" }
      query.$or = [
        { name: regex },
        { category: regex },
        { location: regex },
        { businessName: regex },
      ]
    }
    const result = await menu.find(query).limit(200).toArray()
    res.status(200).send(result)
  } catch (error) {
    console.error("Failed to fetch menu:", error)
    res.status(500).send({
      success: false,
      message: "Failed to fetch menu items",
    })
  }
})

// ---------- GET /

// One approved dish, used by the details page
app.get("/browse-menu/:id", async (req, res) => {
  try {
    const { id } = req.params

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ success: false, message: "Invalid item id" })
    }

    // const item = await menu.findOne({
    //   _id: new ObjectId(id),
    //   approvalStatus: "approved",
    // })
    const item = await menu.findOne({
      _id: new ObjectId(id),
      approvalStatus: "approved",
      isAvailable: true,
    })

    if (!item) {
      return res.status(404).send({ success: false, message: "Item not found" })
    }

    // A blocked vendor's dishes are not public
    const blockedVendors = await getBlockedVendorEmails()
    if (blockedVendors.includes(String(item.vendorEmail || "").toLowerCase())) {
      return res.status(404).send({ success: false, message: "Item not found" })
    }

    res.status(200).send(item)
  } catch (error) {
    console.error("Failed to fetch menu item:", error)
    res.status(500).send({
      success: false,
      message: "Failed to fetch menu item",
    })
  }
})



// ---------- Misc ----------
app.get("/", (req, res) => {
  res.send("pizzahub is running")
})





// ---------- Error handler (must come after all routes) ----------
app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error)
  }

  if (error.status === 400) {
    return res.status(400).send({
      success: false,
      message: error.message,
    })
  }

  console.error("Unhandled server error:", error)
  res.status(500).send({
    success: false,
    message: "Server error",
  })
})


// ---------- Start (must be last) ----------
app.listen(port, () => {
  console.log(`pizzahub is running on port ${port}`)
})
export default app;