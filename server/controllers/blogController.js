import fs from 'fs';
import blogModel from '../models/blogModel.js';

export const addBlogPost = async(req,res) => {

    console.log(req.file)

    try {

        const {originalname, path} = req.file;
        const parts = originalname.split('.');
        const ext = parts[parts.length - 1];
        const newPath = path + '.' + ext;
        fs.renameSync(path, newPath);
    
        console.log(newPath)
    
        const {title,summary,content} = req.body;
        const blogPost = await blogModel.create({
          title,
          summary,
          content,
          cover: newPath,
          author: req.userId,
        });
    
        res.status(200).json(blogPost);
        
    } catch (error) {
        console.log(error)
        res.status(500).json({ error: error.message });
        
    }

}

export const getBlogPost = async (req, res) => {
    res.status(200).json(
        await blogModel.find()
          .populate('author', ['username'])
          .sort({createdAt: -1})
          .limit(20)
      );
}


export const getBlogPostById = async (req, res) => {
    try {
        const {id} = req.params;
        const blogPost = await blogModel.findOne({_id: id}).populate('author', ['username']);
        res.status(200).json(blogPost);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
    
}

// Update Blog Post to be Implemented

// export const updateBlogPost = async(req,res) => {
//     let newPath = null;
//     if (req.file) {
//       const {originalname,path} = req.file;
//       const parts = originalname.split('.');
//       const ext = parts[parts.length - 1];
//       newPath = path+'.'+ext;
//       fs.renameSync(path, newPath);
//     }

// }

export const deleteBlogPost = async (req, res) => {
    try {
        const {id} = req.params;
        const blogPost = await blogModel.deleteOne({_id: id});
        res.status(200).json(blogPost);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
   
}