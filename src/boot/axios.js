import { defineBoot } from "#q-app/wrappers";
import axios from "axios";
import { debounce } from 'quasar';
// 默认配置
const defaultConfig = {
  api: {
    baseURL: 'http://localhost:8080',
    retries: 3
  }
}
// 创建axios实例
const api = axios.create({
  baseURL: defaultConfig.api.baseURL,
  headers: {
    'Content-Type': 'application/json',
  }
});
// 动态更新配置的方法
api.updateConfig = (config) => {
  if (config?.general?.backendPort) {
    api.defaults.baseURL = `http://localhost:${config.general.backendPort}`
  }
}

// 请求拦截器
api.interceptors.request.use(
  config => {
    // 在发送请求之前做些什么
    // 例如添加token
    // const token = localStorage.getItem('token');
    // if (token) {
    //   config.headers.Authorization = `Bearer ${token}`;
    // }
    return config;
  },
  error => {
    // 对请求错误做些什么
    return Promise.reject(error);
  }
);

// 响应拦截器
api.interceptors.response.use(
  response => {
    // 对响应数据做点什么
    return response.data;
  },
  async error => {
    const originalRequest = error.config;

    // 自动重试逻辑
    if (error.response && error.response.status >= 500 && !originalRequest._retry) {
      originalRequest._retry = true;
      originalRequest._retryCount = originalRequest._retryCount || 0;

      // 最多重试3次
      if (originalRequest._retryCount < 3) {
        originalRequest._retryCount++;

        // 指数退避策略，每次重试等待时间增加
        const delay = Math.pow(2, originalRequest._retryCount) * 1000;

        await new Promise(resolve => setTimeout(resolve, delay));
        return api(originalRequest);
      }
    }

    // 对响应错误做点什么
    return Promise.reject(error);
  }
);

// 防抖请求封装
const createDebouncedRequest = (method) => {
  return (url, data = {}, options = {}) => {
    const { debounceTime = 500, ...axiosOptions } = options;

    // 创建一个唯一的键，用于标识请求
    const requestKey = `${method}:${url}:${JSON.stringify(data)}`;

    // 如果没有缓存这个防抖函数，则创建一个
    if (!createDebouncedRequest.cache[requestKey]) {
      createDebouncedRequest.cache[requestKey] = debounce(
        () => {
          return method === 'get' || method === 'delete'
            ? api[method](url, { params: data, ...axiosOptions })
            : api[method](url, data, axiosOptions);
        },
        debounceTime
      );
    }

    return createDebouncedRequest.cache[requestKey]();
  };
};

// 缓存防抖函数
createDebouncedRequest.cache = {};

// 创建增强的API对象
const enhancedApi = {
  // 原始axios实例
  instance: api,

  // 普通请求方法
  get: (url, params = {}, options = {}) => api.get(url, { params, ...options }),
  post: (url, data = {}, options = {}) => api.post(url, data, options),
  put: (url, data = {}, options = {}) => api.put(url, data, options),
  delete: (url, params = {}, options = {}) => api.delete(url, { params, ...options }),

  // 防抖请求方法
  debounced: {
    get: createDebouncedRequest('get'),
    post: createDebouncedRequest('post'),
    put: createDebouncedRequest('put'),
    delete: createDebouncedRequest('delete')
  },

  // 重试请求方法
  retry: async (request, maxRetries = 3, delayMs = 1000) => {
    let retries = 0;

    while (retries < maxRetries) {
      try {
        return await request();
      } catch (error) {
        retries++;
        if (retries >= maxRetries) {
          throw error;
        }

        // 指数退避策略
        const delay = delayMs * Math.pow(2, retries - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  },

  // 更新配置方法
  updateConfig: api.updateConfig
};

export default defineBoot(({ app }) => {
  // 通过this.$axios和this.$api在Vue文件中使用（Options API）
  app.config.globalProperties.$axios = axios;
  app.config.globalProperties.$api = enhancedApi;
});

export { enhancedApi as api };
