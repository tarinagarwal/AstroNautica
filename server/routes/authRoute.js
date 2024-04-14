import express from 'express';
import { login, logout, resetToken, signUp, verifyResetToken } from '../controllers/authController.js';


const authRoute = express.Router();

authRoute.post('/signup', signUp)
authRoute.post('/login', login)
authRoute.get('/logout', logout)
authRoute.post('/forgotpassword',resetToken)
authRoute.get('/resetpassword/:id',verifyResetToken)

export default authRoute;