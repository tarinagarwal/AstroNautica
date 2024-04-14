import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const SECRET_KEY=process.env.SECRET_KEY;

export const auth = (req,res,next) =>{
    try {
        
        let {token} = req.cookies;
        if(token){
            const user= jwt.verify(token,SECRET_KEY)
            req.userId=user.userId
            if(user) {
                next()
            }
        }
        else{
            return res.status(401).json({message:"Unauthorized User"})
        }
       
    } catch (error) {
        console.log(error)
        res.status(500).json({message:"Server Error Occured"})
    }
}