import express from 'express';
import { apod } from '../controllers/pictureController.js';


const pictureRoute = express.Router();

pictureRoute.post('/apod', apod);

export default pictureRoute;