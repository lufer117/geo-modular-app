// core/mapManager.js — Ciclo de vida del mapa único
// ============================================================
// Responsabilidad: inicialización, toggle 2D/3D, sincronización de viewpoint.
// 
//  Principio arquitectónico clave:
//  Map  = modelo de datos (capas, basemap)
//  MapView / SceneView = representaciones visuales del mismo modelo
//
//  Un único Map es consumido por MapView (2D) Y SceneView (3D).
//  Las capas incompatibles con 3D son gestionadas automáticamente por el SDK.
//  No necesitamos duplicar ni clonar capas.
//
//  Expone: initMap(), toggleVista(), getVistaActiva(), getViewActual(), setBasemap()
// ============================================================

