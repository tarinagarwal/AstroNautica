import React, { useEffect, useState } from "react";

const Signup = () => {
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
  }, []);

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
          <form action="">
            <h1>Register</h1>
            <div class="input-box">
              <input type="text" placeholder="First name" required />
            </div>
            <div class="input-box">
              <input type="text" placeholder="Last name" required />
            </div>
            <div class="input-box">
              <input type="text" placeholder="Username" required />
              <i class="bx bxs-user"></i>
            </div>
            <div class="input-box">
              <input
                type="password"
                placeholder="Password"
                id="password"
                required
              />
              <i class="bx bxs-hide" id="eyeicon" onclick="showPassword()"></i>
            </div>
            <div class="input-box">
              <input
                type="password"
                placeholder="Confirm password"
                id="confirm-password"
                required
              />
              <i
                class="bx bxs-hide"
                id="eyeicon-confirm"
                onclick="showPasswordagain()"
              ></i>
            </div>

            <button type="submit" class="btn">
              Create
            </button>

            <div class="register-link">
              <p>
                Already have an account? <a href="index.html">Login</a>
              </p>
            </div>
          </form>
        </div>
      </div>
    </>
  );
};

export default Signup;
