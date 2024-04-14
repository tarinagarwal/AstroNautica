import React, { useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import styles from "./Navbar.module.scss";

import logo from "../../assests/logo.png";
import { useDispatch, useSelector } from "react-redux";
import { FaRegUser, FaRegUserCircle } from "react-icons/fa";
import { MdLogout } from "react-icons/md";
import { logoutUser } from "../../store/authSlice";

const Navbar = () => {
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const [isOpen, setIsOpen] = useState(false);

  const toggleNavbar = () => {
    setIsOpen(!isOpen);
  };

  const isAuthenticated = useSelector((state) => state.auth.isAuthenticated);
  const user = useSelector((state) => state.auth.user);

  const handleLogout = () => {
    dispatch(logoutUser());
    navigate("/");
  };

  return (
    <>
      <div class={styles.navbar}>
        <div class={styles.logo}>
          <img src={logo} alt="Website logo" />
          <h1 className="text-light font-weight-bold">AstroNautica</h1>
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
                <Link to="/blog" onClick={toggleNavbar}>
                  Space Blog
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
            {isAuthenticated ? (
              <div>
                <FaRegUserCircle size={20} />
                <div class="dropdown">
                  {user.username}
                  <div class="dropdown-content">
                    <NavLink to="/profile">
                      <FaRegUser /> My profile
                    </NavLink>
                    <NavLink onClick={handleLogout}>
                      <MdLogout /> Logout
                    </NavLink>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <button onClick={() => navigate("/login")}>Login</button>
                <button onClick={() => navigate("/signup")}>Signup</button>
              </>
            )}
          </div>
        </div>
      </div>
      <Outlet />
    </>
  );
};

export default Navbar;
