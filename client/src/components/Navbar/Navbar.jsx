import React, { useState } from "react";
import { Link, Outlet, useNavigate } from "react-router-dom";
import styles from "./Navbar.module.scss";

import logo from "../../assests/logo.png";

const Navbar = () => {

  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);

  const toggleNavbar = () => {
    setIsOpen(!isOpen);
  };

  return (
    <>
      <div class={styles.navbar}>
        <div class={styles.logo}>
          <img src={logo} alt="Website logo" />
          <h1>AstroNautica</h1>
        </div>
        <div class={styles.nav_Container}>
          <ul className={styles.nav_links}>
            <Link>
              <li>
                <Link to="/" onClick={toggleNavbar}>
                  Home
                </Link>
              </li>
            </Link>

            <Link>
              <li>
                <Link to="/" onClick={toggleNavbar}>
                  News
                </Link>
              </li>
            </Link>

            <Link>
              <li>
                <Link to="/" onClick={toggleNavbar}>
                  Weather
                </Link>
              </li>
            </Link>

            <Link>
              <li>
                <Link to="/" onClick={toggleNavbar}>
                  Contact us
                </Link>
              </li>
            </Link>

          
          </ul>

          <div className={styles.authBtn}>
          <button onClick={()=>navigate('/login')}>Login</button>
          <button onClick={()=>navigate('/signup')}>Signup</button>
        </div>
        
        </div>

       
      </div>
      <Outlet />
    </>
  );
};

export default Navbar;
