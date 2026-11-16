import { createApp, h } from 'vue'
import Antd from 'ant-design-vue'
import 'ant-design-vue/dist/reset.css'
import DemoApp from '../DemoApp.vue'
import { demoApi } from './api.js'
import '../demo.css'

createApp({ render: () => h(DemoApp, { api: demoApi, staticMode: true }) }).use(Antd).mount('#app')
