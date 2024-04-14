import React, { useState } from "react";
import "./Blog.scss";
import { Input } from "@mui/base/Input";
import ReactQuill from "react-quill";
import "react-quill/dist/quill.snow.css";
import axios from "axios";
import API_BASE_URL from "../../config/config";
import { useNavigate } from "react-router-dom";

const BlogForm = () => {

  const navigate = useNavigate();

  const modules = {
    toolbar: [
      [{ header: [1, 2, false] }, { font: [] }],
      ["bold", "italic", "underline", "strike"],
      [{ color: [] }, { background: [] }],
      ["code-block", "formula", "link"],
      [{ list: "ordered" }, { list: "bullet" }],
    ],
  };

  const formats = [
    "header",
    "bold",
    "italic",
    "underline",
    "strike",
    "color",
    "background",
    "font",
    "code-block",
    "formula",
    "link",
    "list",
    "bullet",
  ];

  const [title,setTitle] = useState('');
  const [summary,setSummary] = useState('');
  const [content,setContent] = useState('');
  const [files, setFiles] = useState('');

  const handleSubmit = async(e) => {

    const data = new FormData();
    data.set('title', title);
    data.set('summary', summary);
    data.set('content', content);
    data.set('file', files[0]);
    e.preventDefault();
      console.log(data)
       const blogPost = await axios.post(`${API_BASE_URL}/v1/blog/post`, data, {
      withCredentials: true,
    })

     if(blogPost){

       navigate('/blog')
     }

    console.log(blogPost.data);
  };

  return (
    <>
      <h1>Add Space Blog here</h1>
      <p>add your research and blog here</p>
      <button type="button" onClick={handleSubmit} class="btn btn-dark">
        Post
      </button>
      <div className="blogform">
        <form>
        <div class="mb-3">
          <label for="exampleFormControlInput1" class="form-label">
            Blog Title
          </label>
          <input
            type="text"
            class="form-control"
            id="exampleFormControlInput1"
            placeholder="Blog title"
            name="title"
            value={title}
             onChange={ev => setTitle(ev.target.value)}
          />
        </div>

        <div class="mb-3">
          <label for="exampleFormControlInput1" class="form-label">
            Summary
          </label>
          <input
            type="text"
            class="form-control"
            id="exampleFormControlInput1"
            placeholder="Summary"
            name="summary"
            value={summary}
            onChange={ev => setSummary(ev.target.value)} 
          />
        </div>

        <div class="mb-3">
          <label for="formFile" class="form-label">
            Cover Picture
          </label>
          <input class="form-control" type="file" id="formFile" name="file" onChange={ev => setFiles(ev.target.files)}/>
          
        </div>

        <ReactQuill
          theme="snow"
          modules={modules}
          formats={formats}
          value={content}
          onChange={value => setContent(value)}
          bounds={`[className="editor-container"]`}
        />
        </form>
      </div>
    </>
  );
};

export default BlogForm;
