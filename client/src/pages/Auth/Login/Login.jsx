import React, { useEffect, useState } from 'react'
import '../Auth.scss'

const Login = () => {

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

  return (
    <>
      <div class="background" style={{backgroundImage: `url(${imagesWithText[currentIndex].url})`}}>
      <p class="backgroundText" className="background-text" >{imagesWithText[currentIndex].text}</p>
    <div className="wrapper">
      <form action="">
        <h1>Login</h1>
        <div class="input-box">
          <input type="text" placeholder="Username" required />
          <i class="bx bxs-user"></i>
        </div>
        <div class="input-box">
          <input
          type="password"
          placeholder="password"
          id="password"
          required
          />
          <i class="bx bxs-hide" id="eyeicon" onclick="showPassword()"></i>
        </div>

        <div class="remember-forgot">
          <label for=""><input type="checkbox" />Remember me</label>
          <a href="password.html">Forgot password?</a>
        </div>

        <span class="btn">
          <img src="cosmo.png" alt="" class="cosmo" />
          <span class="front">Login 🚀</span>
          <span class="back"></span>
        </span>
        <div class="register-link">
          <p>Don't have an account? <a href="register.html">Register</a></p>
        </div>
      </form>
    </div>
  </div>
    </>
  )
}

export default Login