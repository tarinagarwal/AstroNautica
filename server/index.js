import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import pictureRoute from './routes/pictureRoute.js';
import authRoute from './routes/authRoute.js';
import { connectDb } from './db/db.js';
import cookieParser from 'cookie-parser';

dotenv.config();

const PORT = process.env.PORT || 5050;

const corsOptions = {
    origin: process.env.CROSS_ORIGIN_URL, 
    credentials: true 
}

const app = express();

app.use(cookieParser());
app.use(express.json());
app.use(cors(corsOptions));
app.use('/v1/auth',authRoute);
app.use('/v1/data/img',pictureRoute);

app.get('/',(req,res)=>{
    res.send('<h1>AstroNautica Backend - Developed By HackGeniuses<h1>')
});

connectDb();

app.listen(PORT, ()=>{
    console.log(`Server Started at Port ${PORT}`)
})