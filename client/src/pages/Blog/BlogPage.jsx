import axios from 'axios';
import React, { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom';
import API_BASE_URL from '../../config/config';

const BlogPage = () => {

    const [postInfo,setPostInfo] = useState(null);
    const {id} = useParams();

    useEffect(() => {

        const getPost =  async () => {
            const post = await axios.get(`${API_BASE_URL}/v1/blog/post/${id}`)
            setPostInfo(post.data);
        }

        getPost();
      }, []);
    
      if (!postInfo) return '';

  return (
    <>
   
    </>
  )
}

export default BlogPage