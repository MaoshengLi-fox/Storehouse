<template>
  <section class="login-page">
    <aside class="login-story">
      <div class="brand"><div class="brand-symbol"><AppIcon name="factory" /></div><div><strong>Factory Desk<span class="brand-dot">.</span></strong><span>工厂经营管理台</span></div></div>
      <div class="login-story-copy">
        <p class="eyebrow">让经营更有序</p>
        <h1>每一笔业务，<br />都清清楚楚。</h1>
        <p>从物料入库，到出货与对账。<br />在同一个工作台，连接日常经营的每个环节。</p>
        <div class="login-workflow">
          <div><span class="workflow-icon"><AppIcon name="box" /></span><div><strong>物料与库存</strong><small>物料建档 · 入库出库 · 库存预警</small></div><span class="workflow-index">01</span></div>
          <div><span class="workflow-icon"><AppIcon name="bill" /></span><div><strong>账单与结算</strong><small>单据关联 · 历史计价 · 往来对账</small></div><span class="workflow-index">02</span></div>
          <div><span class="workflow-icon"><AppIcon name="chart" /></span><div><strong>经营与协作</strong><small>月度趋势 · 团队账号 · 数据共享</small></div><span class="workflow-index">03</span></div>
        </div>
      </div>
      <p class="login-story-footer"><span class="status-dot"></span> 一个工作台，连接工厂的每一天。</p>
    </aside>
    <div class="login-form-panel">
    <form class="login-card" @submit.prevent="handleSubmit">
      <div class="login-welcome-icon"><AppIcon name="factory" /></div>
      <p class="eyebrow">FACTORY DESK / 工作台</p>
      <h2>欢迎回来</h2>
      <p class="login-tip">登录你的账号，开始今天的工作。</p>

      <label class="field">
        <span>账号</span>
        <input v-model.trim="form.username" type="text" autocomplete="username" placeholder="请输入你的账号" required :disabled="loading" />
      </label>

      <label class="field">
        <span>密码</span>
        <div class="password-field"><input v-model="form.password" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" placeholder="请输入密码" required :disabled="loading" /><button type="button" :aria-pressed="showPassword" aria-label="显示或隐藏密码" @click="showPassword = !showPassword">{{ showPassword ? '隐藏' : '显示' }}</button></div>
      </label>

      <p v-if="errorMessage" class="login-error" role="alert"><AppIcon name="alert" />{{ errorMessage }}</p>
      <button class="primary-button login-submit" :disabled="loading" type="submit">
        {{ loading ? '正在登录…' : '登录工作台' }}<AppIcon :name="loading ? 'refresh' : 'arrow'" :class="{ spinning: loading }" />
      </button>

      <p class="login-note"><AppIcon name="shield" />账号由管理员统一分配，忘记密码请联系管理员。</p>
    </form>
    <p class="login-footer">Factory Desk<span>生产 · 库存 · 对账</span></p>
    </div>
  </section>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { desktopApi } from '../lib/desktopApi.js';
import AppIcon from '../components/AppIcon.vue';

const router = useRouter();

const form = reactive({
  username: '',
  password: ''
});

const loading = ref(false);
const showPassword = ref(false);
const errorMessage = ref('');

async function handleSubmit() {
  if (!form.username || !form.password) {
    errorMessage.value = '请填写账号和密码';
    return;
  }

  loading.value = true;
  errorMessage.value = '';

  try {
    await desktopApi.login({ username: form.username, password: form.password });
    await router.replace('/');
  } catch (error) {
    errorMessage.value = error.message || '登录失败';
  } finally {
    loading.value = false;
  }
}
</script>
