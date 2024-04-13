import React from 'react'
import styles from './Footer.module.scss'
import logo from '../../assests/logo.png'
import { Link } from 'react-router-dom'

const Footer = () => {
  return (
    <>
     <footer class = {styles.footer}>
      <div class = {styles.footer_container}>
        

      
      </div>
     <div className = {styles.footer_bottom}>
          <p>Copyright © 2024 AstroNautics - All Rights Reserved</p>
     </div>
     </footer>
    </>
  )
}

export default Footer