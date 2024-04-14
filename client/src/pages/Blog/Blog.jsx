import React, { useEffect, useState } from "react";
import "./Blog.scss";
import { CiCirclePlus } from "react-icons/ci";
import { BiPlus } from "react-icons/bi";
import { useSelector } from "react-redux";
import { useNavigate } from "react-router-dom";
import API_BASE_URL from "../../config/config";
import axios from "axios";
import PostCard from "../../components/BlogPost/PostCard";

const Blog = () => {
  const navigate = useNavigate();

  const isAuthenticated = useSelector((state) => state.auth.isAuthenticated);

  const [posts, setPosts] = useState([]);
  useEffect(() => {
    const getBlogPost = async () => {
      const posts = await axios.get(`${API_BASE_URL}/v1/blog/post`);
      setPosts(posts.data);
    };

    getBlogPost();
  }, []);

  return (
    <>
      <h1 classname="heading text-light font-weight-bold">Blog Posts</h1>
      {isAuthenticated ? (
        <button onClick={() => navigate("/addBlog")} className="addBtn">
          <BiPlus size={30} /> Add Blog
        </button>
      ) : (
        ""
      )}

      {posts.length > 0 && posts.map((post) => <PostCard {...post} />)}
    </>
  );
};

export default Blog;
