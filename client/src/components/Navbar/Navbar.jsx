import React from 'react'
import { Outlet } from 'react-router-dom'
import styles from './Navbar.module.scss'

const Navbar = () => {
  return (
    <>
    <div>Navbar</div>
    <Outlet />
    </>
  )
}

export default Navbar