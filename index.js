import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import { MongoClient, ObjectId } from 'mongodb';
import path from "path"

const app =express()
const port =process.env.PORT ||5000

//middleware
app.use(express.json());
app.use(cors())


//mongodb connection

const client = new MongoClient(`mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.oborgny.mongodb.net/`);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connectedClient =await connectToMongoDB()
const database =client.db("pizzahubdb")
const user =database.collection("user")
const menu =database.collection("menuData")
const profile =database.collection("profile")



app.use("/uploads", express.static(path.join(process.cwd(), "uploads")))
//-----------------------------
//profile related api
// app.get('/profile/:email',async(req,res)=>{
//   const cursor =profile.find({})
//     const result =await cursor.toArray()
//     res.send(result);
// })
// GET one user's profile
app.get("/profile/:email", async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).trim().toLowerCase()

    let result = await profile.findOne({ email })

    // If profile collection doesn't contain the user,
    // get the basic account information from user collection.
    if (!result) {
      result = await user.findOne({ email })
    }

    if (!result) {
      return res.status(404).send({
        success: false,
        message: "Profile not found",
      })
    }

    // Ensure all frontend fields have values
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


// UPDATE user profile
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
    const existingUser = existingProfile || await user.findOne({ email })

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


//menu related api

// app.get('/menu',async(req,res)=>{
//     const query ={}
//     console.log('query',req.query)
//     if(req.query.category){
//       query.category=req.query.category
//     }
//     const cursor = menu.find()
//     const result = await cursor.toArray()
//     res.send(result)
// })
const clean = (value) => (typeof value === "string" ? value.trim() : "")
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

app.get("/menu", async (req, res) => {
  try {
    const query = {}

    const name = clean(req.query.name)
    const category = clean(req.query.category)
    const location = clean(req.query.location)

    console.log("Query:", req.query)

    // Filter by name
    if (name) {
      query.name = {
        $regex: escapeRegex(name),
        $options: "i",
      }
    }

    // Filter by category
    if (category) {
      query.category = {
        $regex: `^${escapeRegex(category)}$`,
        $options: "i",
      }
    }

    // Filter by location
    if (location) {
      query.location = {
        $regex: escapeRegex(location),
        $options: "i",
      }
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
    const { name, category, description, price, location, image } = req.body

    const menuData = {
      name,
      category,
      description,
      price: Number(price),
      location,
      image: image || "",
      approvalStatus: "pending",
      isAvailable: false,
      createdAt: new Date(),
    };

    const result = await menu.insertOne(menuData);

    res.status(201).send({
      success: true,
      message: "Menu item added successfully!",
      insertedId: result.insertedId,
      menu: menuData,
    });
  } catch (error) {
    console.error("Menu creation error:", error);
    res.status(500).send({ success: false, message: error.message });
  }
});
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
    const updateDoc = {
      $set: {
        name: name.trim(),
        price: Number(price),
        location: location.trim(),
        description: description.trim(),
        updatedAt: new Date(),
      },
    }

    const result = await menu.updateOne({ _id: new ObjectId(id) }, updateDoc)

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "Menu item not found" })
    }

    res.send({ message: "Menu item updated", modifiedCount: result.modifiedCount })
  } catch (error) {
    console.error(error)
    res.status(500).send({ message: "Server error" })
  }
})

// DELETE menu item
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

// CHANGE availability (used by the switch in the table)
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

app.get('/',(req,res)=>{
    res.send('pizzahub is running')
})


//find users
app.get('/user',async(req,res)=>{
    const cursor =user.find({})
    const result =await cursor.toArray()
    res.send(result);
})

app.listen(port,()=>{
    console.log(`pizzahub is running on port ${port}`)
})