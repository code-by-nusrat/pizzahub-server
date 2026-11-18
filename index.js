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
const menu =database.collection("menu")



//menu related api
app.post('/menu',async(req,res)=>{
    const menu= req.body;
    const result =await menu.insertOne(menu)
    res.send(result)
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