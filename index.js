
import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import { MongoClient, ObjectId } from 'mongodb'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

const app = express()
const port = process.env.PORT || 5000

// ---------- Middleware ----------
app.use(express.json())
app.use(cors())

// ---------- MongoDB ----------
const client = new MongoClient(
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.oborgny.mongodb.net/`
)

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

// ---------- Profile ----------
// app.get("/profile/:email", async (req, res) => {
//   try {
//     const email = decodeURIComponent(req.params.email).trim().toLowerCase()

//     // The user collection is the source of truth for who this is and their role
//     const account = await user.findOne({ email })

//     if (!account) {
//       return res.status(404).send({
//         success: false,
//         message: "Profile not found",
//       })
//     }

//     const role = account.role || "customer"
//     const profileDoc = await profileCollectionFor(role).findOne({ email })

//     // No saved profile yet: start from the basic account info
//     const base = profileDoc || {
//       name: account.name,
//       image: account.image,
//       createdAt: account.createdAt,
//     }

//     res.status(200).send({
//       ...base,
//       name: base.name || "",
//       email,
//       role,
//       phone: base.phone || "",
//       address: base.address || "",
//       bio: base.bio || "",
//       image: base.image || "",
//       businessName: base.businessName || "",
//       businessLocation: base.businessLocation || "",
//       openingHours: base.openingHours || "",
//     })
//   } catch (error) {
//     console.error("Get profile error:", error)
//     res.status(500).send({
//       success: false,
//       message: "Failed to load profile",
//     })
//   }
// })

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
      ? ["customer", "admin"].includes(actualRole)
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


// ---------- PROFILE UPDATE HELPER ----------

// const updateProfileByRole = async (email, expectedRole, body) => {
//   const account = await user.findOne({ email })

//   if (!account) {
//     return {
//       error: "Account not found",
//       status: 404,
//     }
//   }

//   const actualRole = account.role || "customer"

//   const allowed =
//     expectedRole === "customer"
//       ? ["customer", "admin"].includes(actualRole)
//       : actualRole === "vendor"

//   if (!allowed) {
//     return {
//       error: "You are not authorized to update this profile",
//       status: 403,
//     }
//   }

//   const name = clean(body.name)

//   if (name.length < 2) {
//     return {
//       error: "Name must contain at least 2 characters",
//       status: 400,
//     }
//   }

//   const updateDoc = {
//     name,
//     phone: clean(body.phone),
//     address: clean(body.address),
//     bio: clean(body.bio),
//     image: clean(body.image),
//     updatedAt: new Date(),
//   }

//   if (expectedRole === "vendor") {
//     const businessName = clean(body.businessName)
//     const businessLocation = clean(body.businessLocation)
//     const openingHours = clean(body.openingHours)

//     if (!businessName || !businessLocation || !openingHours) {
//       return {
//         error:
//           "Business name, business location and opening hours are required",
//         status: 400,
//       }
//     }

//     updateDoc.businessName = businessName
//     updateDoc.businessLocation = businessLocation
//     updateDoc.openingHours = openingHours
//   }

//   const collection =
//     expectedRole === "vendor" ? vendorProfile : customerProfile

//   await collection.updateOne(
//     { email },
//     {
//       $set: updateDoc,
//       $setOnInsert: {
//         email,
//         role: actualRole,
//         createdAt: account.createdAt || new Date(),
//       },
//     },
//     { upsert: true }
//   )

//   const updatedProfile = await collection.findOne({ email })

//   return {
//     profile: {
//       ...updatedProfile,
//       role: actualRole,
//     },
//   }
// }


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
      ? ["customer", "admin"].includes(actualRole)
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

app.get("/vendor-profile/:email", async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email)
      .trim()
      .toLowerCase()

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

app.put("/vendor-profile/:email", async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email)
      .trim()
      .toLowerCase()

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

    res.status(200).send({
      success: true,
      message: "Vendor profile updated successfully",
      ...result.profile,
    })
  } catch (error) {
    console.error("Update vendor profile error:", error)

    res.status(500).send({
      success: false,
      message: "Failed to update vendor profile",
    })
  }
})


// ==================================================
// CUSTOMER PROFILE API
// ==================================================

// GET /customer-profile/:email

app.get("/customer-profile/:email", async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email)
      .trim()
      .toLowerCase()

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

app.put("/customer-profile/:email", async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email)
      .trim()
      .toLowerCase()

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
// Reads the premium flag that /payments/checkout-verify writes after a
// successful Stripe payment. Only a boolean is returned.
app.get("/subscription/:email", async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).trim().toLowerCase()

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

app.put("/profile/:email", async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).trim().toLowerCase()

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

// ---------- GET /menu ----------
// Public menu list with optional filters:
//   /menu?name=pepperoni&category=Pizza&location=Dhanmondi&businessName=Pizza%20Hub
app.get("/menu", async (req, res) => {
  try {
    // Public visitors only see approved dishes. Vendor dashboards need their
    // pending/rejected items too, so approval is filtered only when asked:
    //   /menu?approvalStatus=approved | pending | rejected
    //   /menu?approvalStatus=all -> every status
    const query = {}

    const approvalStatus = clean(req.query.approvalStatus)
    if (approvalStatus === "all") {
      // no approval filter
    } else if (approvalStatus) {
      query.approvalStatus = approvalStatus
    } else {
      // Default: only approved dishes are ever returned
      query.approvalStatus = "approved"
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


app.post("/menu", async (req, res) => {
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
    const vendorEmail = clean(email).toLowerCase()

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


// ---------- Orders ----------

// My orders page: /orders?email=x@y.com
app.get('/orders', async (req, res) => {
  try {
    const email = clean(req.query.email).toLowerCase()
    if (!email) return res.status(400).send({ success: false, message: 'email is required' })

    const result = await orders.find({ 'customer.email': email }).sort({ createdAt: -1 }).limit(200).toArray()
    res.send(result)
  } catch (error) {
    console.error('Failed to fetch orders:', error)
    res.status(500).send({ success: false, message: 'Failed to fetch orders' })
  }
})

// ---------- PATCH /orders/:id/cancel ----------
// A customer can cancel only their OWN order, and only while it is pending.
app.patch('/orders/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params
    const email = clean(req.body?.email).toLowerCase()

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
// Verifies a Stripe Checkout session after a successful payment:
//   1. the session is complete and paid
//   2. the transaction has not been saved before (a page refresh must not insert twice)
//   3. the transaction is stored in the read-only `transactions` collection
//   4. the subscription is upgraded only after that verified confirmation
app.post('/payments/checkout-verify', async (req, res) => {
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
    if (account) {
      await user.updateOne(accountQuery, {
        $set: { premium: true, plan: 'premium', updatedAt: new Date() },
      })
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
      message: 'Payment verification failed',
    })
  }
})

// ---------- POST /orders ----------
// Saves ONE order per kitchen, so every order belongs to exactly one vendor
// and a vendor can never touch another vendor's food.
app.post('/orders', async (req, res) => {
  try {
    const { customer, items, delivery, paymentMethod } = req.body || {}

    const email = clean(customer?.email).toLowerCase()
    if (!email) {
      return res.status(400).send({ success: false, message: 'Customer email is required' })
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).send({ success: false, message: 'Order has no items' })
    }

    // Prices and kitchen names come from the database, not from the browser
    const ids = items.map((i) => clean(i.menuId)).filter((id) => ObjectId.isValid(id))
    const dishes = await menu
      .find({ _id: { $in: ids.map((id) => new ObjectId(id)) }, approvalStatus: 'approved' })
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
          id: clean(customer?.id),
          name: clean(customer?.name) || customerDoc?.name || '',
          email,
          phone: clean(customer?.phone) || customerDoc?.phone || '',
        },
        items: vendorItems,
        delivery: {
          address: clean(delivery?.address),
          date: clean(delivery?.date),
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
app.get('/vendor/orders', async (req, res) => {
  try {
    const email = clean(req.query.email).toLowerCase()
    if (!email) return res.status(400).send({ success: false, message: 'email is required' })

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
app.patch('/orders/:id/status', async (req, res) => {
  try {
    const { id } = req.params
    const email = clean(req.body?.email).toLowerCase()
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
// Payment history. Read-only by design: there is deliberately no POST, PUT,
// PATCH or DELETE route for transactions, so records cannot be edited.
//   /transactions                        -> every transaction (admin view)
//   /transactions?vendorEmail=x@y.com    -> one vendor's history
app.get('/transactions', async (req, res) => {
  try {
    const query = {}

    const vendorEmail = clean(req.query.vendorEmail)
    const userId = clean(req.query.userId)
    const paymentStatus = clean(req.query.paymentStatus)

    if (vendorEmail) {
      query.vendorEmail = {
        $regex: `^${escapeRegex(vendorEmail)}$`,
        $options: 'i',
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

// ---------- GET /browse-menu ----------
// Public menu list with optional filters:
//   /browse-menu?name=Smoky%20pepperoni%20Supreme
//   /browse-menu?name=pepperoni&category=Pizza&location=Dhanmondi
app.get("/browse-menu", async (req, res) => {
  try {
    // Public endpoint: only approved dishes are ever returned
    const query = { approvalStatus: "approved" }

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

// ---------- GET /browse-menu/:id ----------
// One approved dish, used by the details page
app.get("/browse-menu/:id", async (req, res) => {
  try {
    const { id } = req.params

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ success: false, message: "Invalid item id" })
    }

    const item = await menu.findOne({
      _id: new ObjectId(id),
      approvalStatus: "approved",
    })

    if (!item) {
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

app.put("/menu/:id", async (req, res) => {
  try {
    const { id } = req.params
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid item id" })
    }

    const { name, price, location, description } = req.body

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

app.delete("/menu/:id", async (req, res) => {
  try {
    const { id } = req.params
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid item id" })
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

app.patch("/menu/:id/availability", async (req, res) => {
  try {
    const { id } = req.params
    const { isAvailable } = req.body

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid item id" })
    }
    if (typeof isAvailable !== "boolean") {
      return res.status(400).send({ message: "isAvailable must be true or false" })
    }

    const item = await menu.findOne({ _id: new ObjectId(id) })

    if (!item) {
      return res.status(404).send({ message: "Menu item not found" })
    }

    // Publishing rules only matter when an item is being turned on
    if (isAvailable) {
      // Only approved dishes can be published
      if (item.approvalStatus !== "approved") {
        return res.status(400).send({
          success: false,
          message: "This item must be approved before it can be published.",
        })
      }

      // Free vendors can publish at most FREE_ACTIVE_ITEM_LIMIT active items.
      // Premium vendors have no limit.
      const premium = await isPremiumBusiness(item.businessName)

      if (!premium) {
        const activeItems = await menu.countDocuments({
          businessName: {
            $regex: `^${escapeRegex(clean(item.businessName))}$`,
            $options: "i",
          },
          isAvailable: true,
          _id: { $ne: item._id },
        })

        if (activeItems >= FREE_ACTIVE_ITEM_LIMIT) {
          return res.status(403).send({
            success: false,
            code: "PREMIUM_REQUIRED",
            message: `Free vendors can publish up to ${FREE_ACTIVE_ITEM_LIMIT} active items. Upgrade to Premium to publish more.`,
            activeItems,
            limit: FREE_ACTIVE_ITEM_LIMIT,
          })
        }
      }
    }

    const result = await menu.updateOne(
      { _id: new ObjectId(id) },
      { $set: { isAvailable, updatedAt: new Date() } }
    )

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "Menu item not found" })
    }

    res.send({ message: "Availability updated", isAvailable })
  } catch (error) {
    console.error(error)
    res.status(500).send({ message: "Server error" })
  }
})

// ---------- Misc ----------
app.get("/", (req, res) => {
  res.send("pizzahub is running")
})

app.get("/user", async (req, res) => {
  const result = await user.find({}).toArray()
  res.send(result)
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