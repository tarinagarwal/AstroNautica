import axios from "axios";
import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import API_BASE_URL from "../../../config/config";
import { Bounce, toast, ToastContainer} from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

const Signup = () => {

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
      setCurrentIndex((prevIndex) =>
        prevIndex === imagesWithText.length - 1 ? 0 : prevIndex + 1
      );
    }, 3000);

    return () => clearInterval(interval);
  }, [imagesWithText.length]);


  const [credential,setcredential]=useState({fullname:"", username:"",email:"",password:"",confirmpassword:""})

  const handlechange=(e)=>{
    setcredential({...credential,[e.target.name]:e.target.value})
  }

  const handlesubmit = async (e)=>{
    e.preventDefault();

    const response = await axios.post(`${API_BASE_URL}/v1/auth/signup`, credential)
    console.log(response.data)

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
          navigate('/login');
        }, 4000);

        
    }



  }

  return (
    <>
      <div
        class="background"
        style={{ backgroundImage: `url(${imagesWithText[currentIndex].url})` }}
      >
        <p class="backgroundText" className="background-text">
          {imagesWithText[currentIndex].text}
        </p>
        <div class="signup-wrapper">
          <form onSubmit={handlesubmit} >
            <h1>Register</h1>
            <div class="input-box">
              <input type="text" name="fullname" placeholder="Full name" value={credential.fullname} onChange={handlechange} required />
            </div>
            <div class="input-box">
              <input type="text" name="username" placeholder="Username" value={credential.username} onChange={handlechange} required />
              <i class="bx bxs-user"></i>
            </div>
            <div class="input-box">
              <input type="email" name="email" placeholder="Email" value={credential.email} onChange={handlechange} required />
            </div>
            <div class="input-box">
              <input
                type="password"
                name="password"
                placeholder="Password"
                id="password"
                value={credential.password}
                onChange={handlechange}
                required
              />
              <i class="bx bxs-hide" id="eyeicon" onclick="showPassword()"></i>
            </div>
            <div class="input-box">
              <input
                type="password"
                name="confirmpassword"
                placeholder="Confirm password"
                id="confirm-password"
                value={credential.confirmpassword}
                onChange={handlechange}
                required
              />
              <i
                class="bx bxs-hide"
                id="eyeicon-confirm"
                onclick="showPasswordagain()"
              ></i>
            </div>

            <button type="submit" class="btn">
              Create account
            </button>

            <div class="register-link">
              <p>
                Already have an account? <Link to='/login'>Login</Link>
              </p>
            </div>
          </form>
        </div>
      </div>
        <ToastContainer />
    </>
  );
};

export default Signup;
