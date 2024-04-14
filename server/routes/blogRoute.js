import express from 'express';
import { auth } from '../middleware/auth.js';
import { addBlogPost, deleteBlogPost, getBlogPost, getBlogPostById } from '../controllers/blogController.js';
import multer from "multer";


const blogRoute = express.Router();


const upload = multer({ dest: 'uploads/blogs/' })

blogRoute.get('/post', getBlogPost);
blogRoute.get('/post/:id', getBlogPostById);
blogRoute.delete('/post/:id', deleteBlogPost);
blogRoute.post('/post', auth, upload.single('file'), addBlogPost);

export default blogRoute;