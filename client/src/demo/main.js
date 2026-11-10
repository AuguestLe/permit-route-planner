import { createApp } from 'vue'
import Antd from 'ant-design-vue'
import 'ant-design-vue/dist/reset.css'
import DemoApp from './DemoApp.vue'
import './demo.css'

createApp(DemoApp).use(Antd).mount('#app')
