/**
 * 应用程序全局配置
 * 包含前后端端口设置及其他可配置项
 */
export default {
  // API 配置
  api: {
    baseURL: 'http://localhost:8080', // 后端服务基础URL
    port: 8080, // 后端服务端口
    timeout: 60000, // API请求超时时间（毫秒）
  },

  // 前端配置
  frontend: {
    port: 9000, // 开发模式下前端服务端口
  },

  // 其他全局配置
  app: {
    name: 'Moonshine-Image',
    version: '1.0.0',
    maxHistoryStates: 5, // 图像处理历史记录最大数量
  }
}