import mongoose from "mongoose";

const blogSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    summary: {
      type: String,
      required: true,
    },
    content: {
      type: String,
    },
    cover: {
      type: String,
    },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "userData" },
  },
  {
    timestamps: true,
  }
);


export default mongoose.model('blogData',blogSchema)