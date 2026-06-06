(function () {
  'use strict';

  var STORAGE_KEY = 'dashboard_view_preference';
  var MOBILE_PATH = '/mobile.html';
  var DESKTOP_PATH = '/index.html';

  function safeGetPreference() {
    try {
      return localStorage.getItem(STORAGE_KEY) || '';
    } catch (error) {
      return '';
    }
  }

  function safeSetPreference(view) {
    try {
      localStorage.setItem(STORAGE_KEY, view);
    } catch (error) {
      // Ignore storage failures.
    }
  }

  function currentView() {
    return /\/mobile\.html$/i.test(window.location.pathname) ? 'mobile' : 'desktop';
  }

  function isPhoneLikeViewport() {
    var ua = navigator.userAgent || '';
    var mobileUa = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua);
    var coarse = !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    var narrow = Math.min(window.innerWidth || 0, (window.screen && window.screen.width) || 0) <= 820;
    return mobileUa || (coarse && narrow) || narrow;
  }

  function buildTargetUrl(pathname, forcedView) {
    var url = new URL(window.location.href);
    url.pathname = pathname;
    url.searchParams.set('view', forcedView);
    return url.toString();
  }

  function switchTo(view) {
    var target = view === 'mobile' ? 'mobile' : 'desktop';
    safeSetPreference(target);
    window.location.href = buildTargetUrl(target === 'mobile' ? MOBILE_PATH : DESKTOP_PATH, target);
  }

  var params = new URLSearchParams(window.location.search);
  var queryView = params.get('view');
  if (queryView === 'mobile' || queryView === 'desktop') {
    safeSetPreference(queryView);
  }

  var preference = queryView || safeGetPreference();
  var pageView = currentView();
  var shouldUseMobile = preference === 'mobile' || (preference !== 'desktop' && isPhoneLikeViewport());

  if (pageView === 'desktop' && shouldUseMobile) {
    window.location.replace(buildTargetUrl(MOBILE_PATH, 'mobile'));
  }

  if (pageView === 'mobile' && preference === 'desktop') {
    window.location.replace(buildTargetUrl(DESKTOP_PATH, 'desktop'));
  }

  window.DashboardViewSwitch = {
    currentView: currentView,
    isPhoneLikeViewport: isPhoneLikeViewport,
    switchTo: switchTo,
  };
}());
