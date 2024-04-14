import React from 'react'
import styles from './Footer.module.scss'
import logo from '../../assests/logo.png'
import { Link } from 'react-router-dom'

const Footer = () => {
  return (
    <>
     <footer className={styles.footer}>
      <div className={styles.container}>
        <div className={styles.row}>
          <div className={styles.footer_col}>
            <h4>AstroNautica</h4>
            <ul>
              <li><Link to="/apod">APOD</Link></li>
              <li><Link to="/weather">Weather</Link></li>
              <li><Link to="/about_us">About Us</Link></li>
              <li><Link to="/privacy_policy">Privacy Policy</Link></li>
            </ul>
          </div>
          <div className={styles.footer_col}>
            <h4>get help</h4>
            <ul>
              <li><Link to="/faqs">FAQs</Link></li>
              <li><Link to="/contact_us">Contact Us</Link></li>
              <li><Link to="/order_status">Order Status</Link></li>
              <li><Link to="/payment_options">Payment Options</Link></li>
            </ul>
          </div>
          <div className={styles.footer_col}>
            <h4>Quick Links</h4>
            <ul>
              <li><Link to="/dashboard">Dashboard</Link></li>
              <li><Link to="/news">News</Link></li>
              <li><Link to="/images">Images</Link></li>
              <li><Link to="/blogs">Blogs</Link></li>
              <li><Link to="/home">Home</Link></li>
            </ul>
          </div>
          <div className={styles.footer_col}>
            <h4>follow us</h4>
            <div className={styles.social_links}>
              <Link to="#"><i className="fab fa-facebook-f"></i></Link>
              <Link to="#"><i className="fab fa-twitter"></i></Link>
              <Link to="#"><i className="fab fa-instagram"></i></Link>
              <Link to="#"><i className="fab fa-linkedin-in"></i></Link>
            </div>
          </div>
        </div>
      </div>
    </footer>
    </>
  )
}

export default Footer