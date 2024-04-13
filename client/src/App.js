import { Route, Routes } from 'react-router-dom';
import './App.scss';
import Layout from './Layout/Layout';
import Home from './pages/Home/Home';
import Login from './pages/Auth/Login/Login';
import Signup from './pages/Auth/Signup/Signup';

function App() {
  return (
    <>
    <Routes>
              <Route path="/" element={<Layout/> }>
                <Route index element={<Home />} />
            
              </Route>
    </Routes>
    <Routes>
                <Route path='/login' element={<Login />} />
                <Route path='/signup' element={<Signup />} />
    </Routes>
    </>
  );
}

export default App;
