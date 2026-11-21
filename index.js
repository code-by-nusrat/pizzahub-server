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
const profile = database.collection("profile")
const orders = database.collection('orders')
const payments = database.collection('payments')
// Read-only payment history shown to admins and vendors
const transactions = database.collection('transactions')

// ---------- Helpers ----------
const clean = (value) => (typeof value === "string" ? value.trim() : "")
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// Free vendors can publish this many active (available) menu items
const FREE_ACTIVE_ITEM_LIMIT = 3

// A business is premium when the account that owns it has premium: true.
// Business names live on the profile, accounts live in the user collection.
async function findBusinessOwner(businessName) {
  const name = clean(businessName)
  if (!name) return null

  const profileDoc = await profile.findOne({
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
app.get("/profile/:email", async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).trim().toLowerCase()

    let result = await profile.findOne({ email })

    // Fall back to the basic account info in the user collection
    if (!result) {
      result = await user.findOne({ email })
    }

    if (!result) {
      return res.status(404).send({
        success: false,
        message: "Profile not found",
      })
    }

    const profileData = {
      ...result,
      name: result.name || "",
      email: result.email || email,
      role: result.role || "customer",
      phone: result.phone || "",
      address: result.address || "",
      bio: result.bio || "",
      image: result.image || "",
      businessName: result.businessName || "",
      businessLocation: result.businessLocation || "",
      openingHours: result.openingHours || "",
    }

    res.status(200).send(profileData)
  } catch (error) {
    console.error("Get profile error:", error)
    res.status(500).send({
      success: false,
      message: "Failed to load profile",
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

    const existingProfile = await profile.findOne({ email })
    const existingUser = existingProfile || (await user.findOne({ email }))

    if (!existingUser) {
      return res.status(404).send({
        success: false,
        message: "User not found",
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

    // Only vendors can update restaurant details
    if (existingUser.role === "vendor") {
      updateDoc.businessName = businessName?.trim() || ""
      updateDoc.businessLocation = businessLocation?.trim() || ""
      updateDoc.openingHours = openingHours?.trim() || ""
    }

    await profile.updateOne(
      { email },
      {
        $set: updateDoc,
        $setOnInsert: {
          email,
          role: existingUser.role || "customer",
          createdAt: existingUser.createdAt || new Date(),
        },
      },
      { upsert: true }
    )

    const updatedProfile = await profile.findOne({ email })

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

// ---------- Menu ----------
// app.get("/menu", async (req, res) => {
//   try {
//     const query = {}

//     const name = clean(req.query.name)
//     const category = clean(req.query.category)
//     const location = clean(req.query.location)
//     const businessName = clean(req.query.businessName)
//     const approvalStatus = clean(req.query.approvalStatus)

//     if (name) {
//       query.name = { $regex: escapeRegex(name), $options: "i" }
//     }

//     if (category) {
//       query.category = { $regex: `^${escapeRegex(category)}$`, $options: "i" }
//     }

//     if (location) {
//       query.location = { $regex: escapeRegex(location), $options: "i" }
//     }

//     // Exact business match, case-insensitive
//     if (businessName) {
//       query.businessName = {
//         $regex: `^${escapeRegex(businessName)}$`,
//         $options: "i",
//       }
//     }

//     if (approvalStatus) {
//       query.approvalStatus = approvalStatus
//     }

//     console.log("MongoDB filter:", query)

//     const result = await menu.find(query).toArray()
//     res.status(200).send(result)
//   } catch (error) {
//     console.error("Failed to fetch menu:", error)
//     res.status(500).send({
//       success: false,
//       message: "Failed to fetch menu items",
//     })
//   }
// })


// ---------- Helpers ----------

// Only accept plain strings. Arrays and objects (e.g. ?name[$ne]=x) become "".

// Make user text safe to use inside a regular expression


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
      name,
      category,
      description,
      price,
      location,
      image,
      businessName,
    } = req.body

    const itemName = clean(name)
    const itemCategory = clean(category)
    const itemDescription = clean(description)
    const itemLocation = clean(location)
    const itemImage = clean(image)
    const itemPrice = Number(price)
    const itemBusinessName = clean(businessName)

    if (itemName.length < 3) {
      return res.status(400).send({
        success: false,
        message: "Item name must contain at least 3 characters",
      })
    }

    if (!itemCategory) {
      return res.status(400).send({ success: false, message: "Category is required" })
    }

    if (!itemDescription) {
      return res.status(400).send({ success: false, message: "Description is required" })
    }

    if (!Number.isFinite(itemPrice) || itemPrice <= 0) {
      return res.status(400).send({
        success: false,
        message: "Price must be a number greater than 0",
      })
    }

    if (!itemLocation) {
      return res.status(400).send({ success: false, message: "Location is required" })
    }

    if (!itemImage) {
      return res.status(400).send({ success: false, message: "Item image is required" })
    }

    if (!/^https?:\/\/\S+$/i.test(itemImage)) {
      return res.status(400).send({
        success: false,
        message: "Item image must be a valid image URL",
      })
    }

    if (!itemBusinessName) {
      return res.status(400).send({ success: false, message: "Business name is required" })
    }

    const menuData = {
      name: itemName,
      category: itemCategory,
      description: itemDescription,
      price: itemPrice,
      businessName: itemBusinessName,
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
      message: error.message,
    })
  }
})

//orderList related api
app.post('/orders', async (req, res) => {
  try {
    const order = req.body
    if (
      !order ||
      typeof order !== 'object' ||
      Array.isArray(order) ||
      Object.keys(order).length === 0
    ) {
      return res.status(400).send({ success: false, message: 'Order data is required' })
    }

    const result = await orders.insertOne({
      ...order,
      createdAt: order.createdAt ? new Date(order.createdAt) : new Date(),
    })

    res.status(201).send({ success: true, insertedId: result.insertedId })
  } catch (error) {
    console.error('Order creation failed:', error)
    res.status(500).send({ success: false, message: 'Failed to place order' })
  }
})

//payment related api
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

    // Vendor details: the account that paid -> its business profile
    const accountQuery = ObjectId.isValid(userId)
      ? { _id: new ObjectId(userId) }
      : { id: userId }

    const account = await user.findOne(accountQuery)
    const email = (account?.email || customer_email || '').toLowerCase()
    const profileDoc = email ? await profile.findOne({ email }) : null

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
// app.post("/payments/checkout-verify", async (req, res) => {
//   try {
//     const sessionId = clean(req.body.sessionId)
//     if (!sessionId) {
//       return res.status(400).send({ success: false, message: "sessionId is required" })
//     }

//     const session = await stripe.checkout.sessions.retrieve(sessionId)
//     const { status, payment_status, customer, customer_email, metadata, subscription } = session

//     if (status !== "complete" || payment_status !== "paid") {
//       return res.status(400).send({ success: false, message: "Payment not completed" })
//     }

//     const userId = metadata?.userId
//     if (!userId) {
//       return res.status(400).send({ success: false, message: "No user on this payment" })
//     }

//     // Already processed? A page refresh must not insert twice.
//     if (await payments.findOne({ sessionId })) {
//       return res.send({ success: true, alreadyProcessed: true })
//     }

//     const result = await payments.insertOne({
//       sessionId,
//       status,
//       payment_status,
//       customer,
//       customer_email,
//       userId,
//       subscription,
//       payment_date: new Date(),
//     })

//     const query = ObjectId.isValid(userId) ? { _id: new ObjectId(userId) } : { id: userId }
//     await user.updateOne(query, { $set: { premium: true, updatedAt: new Date() } })

//     res.send({ success: true, insertedId: result.insertedId })
//   } catch (error) {
//     console.error("Checkout verify failed:", error)
//     res.status(500).send({ success: false, message: "Payment verification failed" })
//   }
// })





// ---------- GET /browse-menu ----------
// Uses the `clean` and `escapeRegex` helpers already in your index.js.
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