import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import authModel from '../models/authModel.js';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer'

dotenv.config();

const SECRET_KEY = process.env.SECRET_KEY;


export const signUp = async(req, res) => {

    try {

        const { fullname, username, email, password } = req.body;

        const existingUser = await authModel.findOne({ email });

        if (existingUser) {
            return res.status(200).json({ message: 'User already exists with this email.', status: 'failed' });
        }

        const user = await authModel.findOne({ username });

        if (user) {
            return res.status(200).json({ message: 'Username already taken!', status: 'failed'  });
        }


        const hashedPassword = await bcrypt.hash(password, 10);

        const newUser = new authModel({
            fullname: fullname,
            username: username,
            email,
            password: hashedPassword
        });

        await newUser.save();

        res.status(201).json({ message: 'User created successfully.', status: 'success' });

    } catch (error) {

        console.error('Error signing up:', error);
        res.status(500).json({ message: 'Internal server error.', status: 'failed' });
    };

};

export const login = async(req, res) => {

    try {

        const { email, password } = req.body;

        const user = await authModel.findOne({ email });

        if (!user) {
            return res.status(401).json({ message: 'Invalid email or password.' , status: 'failed' });
        }

        const passwordMatch = await bcrypt.compare(password, user.password);

        if (!passwordMatch) {
            return res.status(401).json({ message: 'Invalid email or password.', status: 'failed' });
        }

        const token = jwt.sign({ userId: user._id }, SECRET_KEY, { expiresIn: '30d' });

        res.cookie('token', token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 }); 

        res.status(200).json({ message: 'Login successful.', username: user.username, userId: user._id, status: 'success' });

    } catch (error) {
        console.error('Error logging in:', error);
        res.status(500).json({ message: 'Internal server error.', status: 'failed' });
    };

};



export const resetToken=async (req,res)=>{
    const {email}=req.body
    const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port:587,
        secure: false,
        auth: {
          user: "sarthakpatel230204@gmail.com",
          pass: "bwea kvgy ajld pfst",
        },
      });

      async function sendmail(username,resetlink,email) {
       
        const info = await transporter.sendMail({
          from: 'sarthakpatel230204@gmail.com', 
          to: email, 
          subject: "Password Reset", 
         
          html: `
                Dear ${username},
                <br><br>
                We received a request to reset the password associated with your account. If you did not make this request, please ignore this email.
                <br><br>
                To reset your password, click on the following button:
                <br><br>
                <button style='background-color:#00DB82; padding:8px; border: 1px solid #00985D;
                border-radius: 5px;'>
                <a  style='color:black; text-decoration:none;' href='${resetlink}'>Reset Password</a>
                </button>
                <br><br>
                Please note that this link is valid for 5 minutes only.
                <br><br>
                If you're having trouble clicking the link, you can copy and paste it into your browser's address bar.
                <br><br>
                If you did not request a password reset or if you have any questions, please contact our support team at [Support Email Address].
                <br><br>
                Thank you,
                WebName
          `, 
        });
        console.log("Message sent: %s", info.messageId);
    }
    try {
        const user= await authModel.findOne({email:email})
        if(!user){
            return res.status(404).json({message:"User Doesn't Exist!"})
        }
        else{
            const token=jwt.sign({email:user.email,username:user.username},SECRET_KEY,{ expiresIn: 300 })
            const resetlink=`${process.env.BACKEND_URL}/user/resetpassword/${token}`
            await sendmail(user.username,resetlink,email)
            res.status(200).json({message:"User Exist!"})
        }
    } catch (error) {
        console.log(error)
        res.status(500).json({message:"Internal Server Error Occured"}) 
    }


}

export const verifyResetToken=async(req,res)=>{
    const token=req.params.id;
    jwt.verify(token,SECRET_KEY,{},(err,data)=>{
        if(data){
            res.render('reset_password', { token: token, email:data.email,username:data.username});
        }
        if(err){
            if (err.name === 'TokenExpiredError') {
                res.render('error')
              } else {
                res.render('error')
              }
        }
        })
}
