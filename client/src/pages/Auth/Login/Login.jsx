import React, { useEffect, useState } from 'react'
import '../Auth.scss'
import { Bounce, ToastContainer, toast } from 'react-toastify';
import API_BASE_URL from '../../../config/config';
import axios from 'axios';
import { Link, useNavigate } from 'react-router-dom';

const Login = () => {

  const navigate = useNavigate();
  const [currentIndex, setCurrentIndex] = useState(0);

  const imagesWithText = [
    { url: "Moon2.jpg", text: "Moon" },
    { url: "astroid.png", text: "Asteroid" },
    { url: "Aurora1.jpg", text: "Aurora" },
    { url: "blackhole.jpg", text: "Black Hole" },
    { url: "earth.jpg", text: "Earth" },
  ];

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentIndex(prevIndex =>
        prevIndex === imagesWithText.length - 1 ? 0 : prevIndex + 1
      );
    }, 3000);

    return () => clearInterval(interval);
  }, []);


  const [credential,setcredential]=useState({email:"", password:""})

  const handlechange=(e)=>{
    setcredential({...credential,[e.target.name]:e.target.value})
  }

  const handlesubmit = async (e)=> {
    e.preventDefault();
    const response = await axios.post(`${API_BASE_URL}/v1/auth/login`, credential);
    
    if(response.data.status === 'failed'){
      toast.error(response.data.message, {
        position: "top-left",
        autoClose: 5000,
        hideProgressBar: false,
        closeOnClick: true,
        pauseOnHover: true,
        draggable: true,
        progress: undefined,
        theme: "dark",
        transition: Bounce,
        });
    }
    else{
      toast.success(response.data.message, {
        position: "top-left",
        autoClose: 5000,
        hideProgressBar: false,
        closeOnClick: true,
        pauseOnHover: true,
        draggable: true,
        progress: undefined,
        theme: "light",
        transition: Bounce,
        });

        setTimeout(() => {
          navigate('/');
        }, 4000);

        
    }

  }

  return (
    <>
      <div class="background" style={{backgroundImage: `url(${imagesWithText[currentIndex].url})`}}>
      <p class="backgroundText" className="background-text" >{imagesWithText[currentIndex].text}</p>
    <div className="wrapper">
      <form onSubmit={handlesubmit}>
        <h1>Login</h1>
        <div class="input-box">
          <input type="email" name='email' value={credential.email} onChange={handlechange} placeholder="email" required />
          <i class="bx bxs-user"></i>
        </div>
        <div class="input-box">
          <input
          type="password"
          name='password'
          value={credential.password}
          onChange={handlechange}
          placeholder="password"
          id="password"
          required
          />
          <i class="bx bxs-hide" id="eyeicon" onclick="showPassword()"></i>
        </div>

        <div class="remember-forgot">
          <label for=""><input type="checkbox" />Remember me</label>
          <Link to='/resetPassword'>Forgot password?</Link>
        </div>
        <button type='submit'>Login 🚀</button>
        <div class="register-link">
          <p>Don't have an account? <Link to = "/signup">Register</Link></p>
        </div>
      </form>
    </div>
  </div>
  <ToastContainer />
    </>
  )
}

export default Login