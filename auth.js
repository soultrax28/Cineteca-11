// auth.js - Protege las páginas que requieren login

const API_URL = 'http://localhost:3000';

// Verificar si el usuario está logueado
function checkAuth() {
    const token = localStorage.getItem('token');
    const usuario = localStorage.getItem('usuario');

    if (!token || !usuario) {
        alert('❌ Debes iniciar sesión primero');
        window.location.href = 'login.html';
        return false;
    }

    return true;
}

// Obtener datos del usuario actual
function getCurrentUser() {
    const usuarioStr = localStorage.getItem('usuario');
    return usuarioStr ? JSON.parse(usuarioStr) : null;
}

// Cerrar sesión
function logout() {
    if (confirm('¿Estás seguro que quieres cerrar sesión?')) {
        localStorage.removeItem('token');
        localStorage.removeItem('usuario');
        window.location.href = 'login.html';
    }
}

// Hacer las funciones disponibles globalmente
window.checkAuth = checkAuth;
window.getCurrentUser = getCurrentUser;
window.logout = logout;