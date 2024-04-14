import React, { useEffect, useState } from 'react'
import '../Auth.scss'
import { Bounce, ToastContainer, toast } from 'react-toastify';
import { Link, useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { loginUser } from '../../../store/authSlice';

const Login = () => {

  const navigate = useNavigate();
  const dispatch = useDispatch();
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
    dispatch(loginUser(credential));
  }

  const error = useSelector((state) => state.auth.error);
  const user = useSelector((state) => state.auth.user);
  const isAuthenticated = useSelector((state) => state.auth.isAuthenticated);


  useEffect(()=>{
    if(isAuthenticated){
      navigate('/')
    }

  },[isAuthenticated])


  useEffect(() => {
    if (error && error.status === 'failed') {
      toast.error(error.message, {
        position: 'top-left',
        autoClose: 5000,
        hideProgressBar: false,
        closeOnClick: true,
        pauseOnHover: true,
        draggable: true,
        progress: undefined,
        theme: 'dark',
        transition: Bounce,
      });
    } else if (user) {
      toast.success(user.message, {
        position: "top-left",
        autoClose: 5000,
        hideProgressBar: false,
        closeOnClick: true,
        pauseOnHover: true,
        draggable: true,
        progress: undefined,
        theme: "DARK",
        transition: Bounce,
      });
    }
  }, [error, user]);


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
  
    </>
  )
}

export default Login