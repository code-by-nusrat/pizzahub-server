import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import { MongoClient } from 'mongodb';


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

//-------------------------------
import multer from "multer";
import path from "path";
import fs from "fs";

// Create uploads folder if it doesn't exist
const uploadDir = "uploads";

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure image storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.round(
      Math.random() * 1e9
    )}${path.extname(file.originalname)}`;

    cb(null, uniqueName);
  },
});

// Create upload middleware
const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed!"));
    }
  },
});

//
app.use("/uploads", express.static("uploads"));
//------------------------------

//menu related api
// app.post('/menu',async(req,res)=>{
//     const menu= req.body;
//     const result =await menu.insertOne(menu)
//     res.send(result)
// })
app.get('/menu',async(req,res)=>{
    const cursor = menu.find()
    const result = await cursor.toArray()
    res.send(result)
})
app.post("/menu", upload.single("image"), async (req, res) => {
  try {
    const menuData = {
      name: req.body.name,
      category: req.body.category,
      description: req.body.description,
      price: Number(req.body.price),
      location: req.body.location,
      image: req.file
        ? `http://localhost:5000/uploads/${req.file.filename}`
        : "",
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

    res.status(500).send({
      success: false,
      message: error.message,
    });
  }
});


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