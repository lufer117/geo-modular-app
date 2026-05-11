// layers.js
// ============================================================
// SISTEMA DE CONFIGURACIÓN
// En el futuro estos datos vendrán de un JSON externo o BD.
// La estructura de cada objeto NO cambiará cuando eso ocurra.
// ============================================================

export const CAPAS_CONFIG = [
  {
    id: "catastro",
    title: "Catastro",
    description: "",          // ← vacío ahora, se rellena cuando llegue la BD
    tipo: "WMS",
    url: "https://ovc.catastro.meh.es/cartografia/INSPIRE/spadgcwms.aspx",
    sublayers: [{ name: "CP.CadastralParcel" }],
    visible: true
  },
  {
    id: "pnoa",
    title: "Ortofoto PNOA (IGN)",
    description: "",          // ← vacío ahora, se rellena cuando llegue la BD
    tipo: "WMS",
    url: "https://www.ign.es/wms-inspire/pnoa-ma",
    sublayers: [{ name: "OI.OrthoimageCoverage" }],
    visible: true
  },
  {
    id: "usos-suelo",
    title: "Usos del suelo (CORINE)",
    description: "",          // ← vacío ahora, se rellena cuando llegue la BD
    tipo: "WMS",
    url: "https://servicios.idee.es/wfs-inspire/ocupacion-suelo",
    sublayers: [{ name: "LC.LandCoverSurfaces" }],
    visible: false
  }
];