import { createSlice } from '@reduxjs/toolkit';
import axios from 'axios';
import API_BASE_URL from '../config/config';

const authSlice = createSlice({
  name: 'auth',
  initialState: {
    isAuthenticated: false,
    user: null,
    error: null,
  },
  reducers: {
    loginSuccess(state, action) {
      state.isAuthenticated = true;
      state.user = action.payload;
      state.error = null;
    },
    loginFailure(state, action) {
      state.isAuthenticated = false;
      state.user = null;
      state.error = action.payload;
    },
    logout(state) {
      state.isAuthenticated = false;
      state.user = null;
      state.error = null;
    },
  },
});

export const { loginSuccess, loginFailure, logout } = authSlice.actions;

export default authSlice.reducer;


export const loginUser = (credentials) => async (dispatch) => {
  try {
    const user = await axios.post(`${API_BASE_URL}/v1/auth/login`, credentials);
    dispatch(loginSuccess(user.data));
  } catch (error) {
    dispatch(loginFailure(error.response.data));
  }
};


export const logoutUser = () => async (dispatch) => {
    try {
       await axios.get(`${API_BASE_URL}/v1/auth/logout`,{
        withCredentials: true
    });
       dispatch(logout());
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };