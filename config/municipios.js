// config/municipios.js
// Lista manual para el fase 1 del prototipo TFM.
// Estructura compatible con INE para evolucionar a opción JSON completo INE
// o API INE en tiempo real sin cambiar ningún otro módulo.
//
// Campos INE oficiales:
//   cpro  → código de provincia (2 dígitos)
//   cmun  → código de municipio dentro de provincia (3 dígitos)
//   codigo_ine = cpro + cmun (5 dígitos) — clave primaria INE
//
// Campos añadidos manualmente por ahora:
//   ccaa_code  → código CCAA INE (2 dígitos)
//   bbox       → [xmin, ymin, xmax, ymax] WGS84 — no existe en INE, viene de IGN

export const municipioData = [
  {
    codigo_ine:       "31201",              // CPRO(31) + CMUN(201)
    nombre:           "Pamplona/Iruña",     // NOMBRE INE
    provincia_code:   "31",                 // CPRO
    provincia_nombre: "Navarra",
    ccaa_code:        "15",                 // Comunidad Foral de Navarra
    ccaa_nombre:      "Comunidad Foral de Navarra",
    bbox:             [-1.717, 42.769, -1.595, 42.843]  // WGS84
  },
  {
    codigo_ine:       "28079",
    nombre:           "Madrid",
    provincia_code:   "28",
    provincia_nombre: "Madrid",
    ccaa_code:        "13",                 // Comunidad de Madrid
    ccaa_nombre:      "Comunidad de Madrid",
    bbox:             [-3.889, 40.312, -3.524, 40.644]
  },
  {
    codigo_ine:       "08019",
    nombre:           "Barcelona",
    provincia_code:   "08",
    provincia_nombre: "Barcelona",
    ccaa_code:        "09",                 // Cataluña
    ccaa_nombre:      "Cataluña",
    bbox:             [2.052, 41.320, 2.228, 41.469]
  }
];