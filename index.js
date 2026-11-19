import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import { MongoClient, ObjectId } from 'mongodb'

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

// ---------- Helpers ----------
const clean = (value) => (typeof value === "string" ? value.trim() : "")
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

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
app.get("/menu", async (req, res) => {
  try {
    const query = {}

    const name = clean(req.query.name)
    const category = clean(req.query.category)
    const location = clean(req.query.location)
    const businessName = clean(req.query.businessName)
    const approvalStatus = clean(req.query.approvalStatus)

    if (name) {
      query.name = { $regex: escapeRegex(name), $options: "i" }
    }

    if (category) {
      query.category = { $regex: `^${escapeRegex(category)}$`, $options: "i" }
    }

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

    if (approvalStatus) {
      query.approvalStatus = approvalStatus
    }

    console.log("MongoDB filter:", query)

    const result = await menu.find(query).toArray()
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