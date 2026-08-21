import axios from "axios";
import { mockClient } from "./mockClient";

// 是否使用 mock 数据（开发测试用；v2 已连真实库 huandian_v2，默认走真实后端）
const USE_MOCK = false;

// 创建 axios 客户端
const axiosClient = axios.create({
  baseURL: "/api",
  timeout: 30000,
});

// 统一附加登录 token；401 时清空并跳转登录页
axiosClient.interceptors.request.use((config) => {
  const token = localStorage.getItem("dsh_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

axiosClient.interceptors.response.use(
  (resp) => resp,
  (error) => {
    if (error?.response?.status === 401) {
      localStorage.removeItem("dsh_token");
      localStorage.removeItem("dsh_user");
      if (!window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
    }
    return Promise.reject(error);
  },
);

// 根据配置选择使用真实 API 还是 mock 数据
const client = USE_MOCK ? mockClient : axiosClient;

export default client;
