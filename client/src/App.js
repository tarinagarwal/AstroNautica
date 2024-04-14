import { Route, Routes } from 'react-router-dom';
import './App.scss';
import Layout from './Layout/Layout';
import Home from './pages/Home/Home';
import Login from './pages/Auth/Login/Login';
import Signup from './pages/Auth/Signup/Signup';
import { ToastContainer } from 'react-toastify';
import Profile from './pages/Profile/Profile';

function App() {
  return (
    <>
    <Routes>
              <Route path="/" element={<Layout/> }>
                <Route index element={<Home />} />
                <Route path='/profile' element={<Profile />} />
            
              </Route>
    </Routes>
    <Routes>
                <Route path='/login' element={<Login />} />
                <Route path='/signup' element={<Signup />} />
    </Routes>
    <ToastContainer />
    </>
  );
}

export default App;
