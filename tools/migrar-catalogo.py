"""
migrar-catalogo.py

Script de transformación: Excel (.xlsx) o CSV → catalogo-capas.json

USO:
    Opción A — desde Excel directamente (recomendado):
        python migrar-catalogo.py capas.xlsx

    Opción B — desde CSV exportado:
        python migrar-catalogo.py capas.csv

    El archivo catalogo-capas.json se genera en la misma carpeta.

REQUISITOS:
    pip install openpyxl pandas

COLUMNAS ESPERADAS EN EL EXCEL/CSV:
    bloque_tematico, subtema, nombre_capa, proveedor, tipo_acceso,
    url_endpoint, cobertura_geografica, cobertura_codigo,  
    disponibilidad_municipal, coste, requiere_registro, formato_datos,
    tematica_inspire, notas_limitaciones, capabilities, pts_tematica,
    pts_cobertura, pts_fuente, pts_tecnica, total_pts, prioridad_app,
    justificacion_prioridad, estado_revision, referencia
"""

import sys
import json
import re
import unicodedata
from pathlib import Path

try:
    import pandas as pd
except ImportError:
    print("❌ Falta la dependencia 'pandas'. Instálala con: pip install pandas openpyxl")
    sys.exit(1)


# ─────────────────────────────────────────────
# CONFIGURACIÓN
# ─────────────────────────────────────────────
ARCHIVO_SALIDA = "catalogo-capas-ne.json"

# Filtros de inclusión
PRIORIDADES_INCLUIDAS    = {"P0 - MVP", "P1 - Alta", "P2 - Media"}
ESTADOS_INCLUIDOS        = {"Revisada"}
COSTES_INCLUIDOS         = {"Gratuita"}
DISPONIBILIDAD_EXCLUIDA  = {"RECORTE", "LOTE"}  # no viables sin backend

# Mapeo cobertura_geografica → cobertura.tipo
MAPA_COBERTURA = {
    "Nacional":                    "nacional",
    "Autonómico":                  "autonomica",
    "Provincial o Supramunicipal": "provincial",
    "Municipal / Local":           "municipal",
    "Europeo":                     "europeo",
    "Global / Mundial":            "global",
}


# ─────────────────────────────────────────────
# UTILIDADES
# ─────────────────────────────────────────────

def slugify(texto: str, max_len: int = 60) -> str:
    """
    Convierte texto libre a kebab-case sin tildes.
    Ejemplo: "FEGA - MAPA" + "WMS SIGPAC" → "fega-mapa-wms-sigpac"
    """
    texto = unicodedata.normalize("NFD", texto.lower())
    texto = "".join(c for c in texto if unicodedata.category(c) != "Mn")  # elimina diacríticos
    texto = re.sub(r"[^a-z0-9\s-]", "", texto)   # elimina caracteres especiales
    texto = re.sub(r"[\s-]+", "-", texto).strip("-")
    return texto[:max_len]


def limpiar(valor) -> str:
    """Convierte NaN de pandas a cadena vacía y elimina espacios."""
    if pd.isna(valor):
        return ""
    return str(valor).strip()


def construir_cobertura(cobertura_geografica: str, cobertura_codigo: str) -> dict:
    """
    Construye el objeto cobertura a partir de los campos del Excel.

    cobertura_codigo puede ser:
      - vacío           → nacional, europeo, global
      - "15"            → código CCAA (autonómica)
      - "31"            → código provincia (provincial)
      - "31201,31007"   → códigos INE separados por coma (municipal)
    """
    tipo = MAPA_COBERTURA.get(cobertura_geografica.strip())

    if not tipo:
        print(f"  ⚠  cobertura desconocida: '{cobertura_geografica}' → campo cobertura incompleto")
        return {"tipo": "desconocida"}

    cobertura = {"tipo": tipo}
    codigo    = cobertura_codigo.strip()

    if tipo == "autonomica":
        if codigo:
            cobertura["ccaa_code"] = codigo
        else:
            print(f"  ⚠  falta cobertura_codigo para cobertura autonómica")

    elif tipo == "provincial":
        if codigo:
            cobertura["provincia_code"] = codigo
        else:
            print(f"  ⚠  falta cobertura_codigo para cobertura provincial")

    elif tipo == "municipal":
        if codigo:
            cobertura["codigos_ine"] = [c.strip() for c in codigo.split(",") if c.strip()]
        else:
            print(f"  ⚠  falta cobertura_codigo para cobertura municipal")

    # nacional, europeo, global: no necesitan código adicional

    return cobertura


def aplicar_filtros(fila: pd.Series) -> tuple[bool, str]:
    """
    Aplica los filtros de inclusión sobre una fila.
    Devuelve (incluida: bool, motivo: str).
    """
    coste        = limpiar(fila.get("coste", ""))
    estado       = limpiar(fila.get("estado_revision", ""))
    prioridad    = limpiar(fila.get("prioridad_app", ""))
    disponib     = limpiar(fila.get("disponibilidad_municipal", "")).upper()

    if coste not in COSTES_INCLUIDOS:
        return False, f"coste: '{coste}'"
    if estado not in ESTADOS_INCLUIDOS:
        return False, f"estado_revision: '{estado}'"
    if prioridad not in PRIORIDADES_INCLUIDAS:
        return False, f"prioridad_app: '{prioridad}'"
    if disponib in DISPONIBILIDAD_EXCLUIDA:
        return False, f"disponibilidad_municipal: '{disponib}'"

    return True, ""


def transformar_fila(fila: pd.Series) -> dict:
    """Convierte una fila del Excel/CSV en un objeto de capa para el catálogo."""

    proveedor   = limpiar(fila.get("proveedor", ""))
    nombre_capa = limpiar(fila.get("nombre_capa", ""))
    tipo_acceso = limpiar(fila.get("tipo_acceso", ""))

    capa_id = slugify(f"{proveedor}-{nombre_capa}-{tipo_acceso}")

    # Puntuaciones — se convierten a int con fallback a 0
    def to_int(campo):
        try:
            return int(float(limpiar(fila.get(campo, "0")) or "0"))
        except ValueError:
            return 0

    return {
        "id":    capa_id,
        "title": nombre_capa,

        "bloque_tematico": limpiar(fila.get("bloque_tematico", "")),
        "subtema":         limpiar(fila.get("subtema", "")),
        "proveedor":       proveedor,

        "tipo": tipo_acceso,           # alimenta layerFactory.js
        "url":  limpiar(fila.get("url_endpoint", "")),
        "capabilities_url": limpiar(fila.get("capabilities", "")) or None,

        "formato":    limpiar(fila.get("formato_datos", "")),
        "inspire":    limpiar(fila.get("tematica_inspire", "")),
        "notas":      limpiar(fila.get("notas_limitaciones", "")),
        "referencia": limpiar(fila.get("referencia", "")) or None,

        "requiere_registro": limpiar(fila.get("requiere_registro", "")).lower() in ("sí", "si", "yes", "true"),
        "coste":   limpiar(fila.get("coste", "")),
        "visible": False,              # siempre False — regla de arquitectura

        "disponibilidad_municipal": limpiar(fila.get("disponibilidad_municipal", "")),

        "puntuacion": {
            "tematica":  to_int("pts_tematica"),
            "cobertura": to_int("pts_cobertura"),
            "fuente":    to_int("pts_fuente"),
            "tecnica":   to_int("pts_tecnica"),
            "total":     to_int("total_pts"),
        },

        "prioridad": limpiar(fila.get("prioridad_app", "")),

        "cobertura": construir_cobertura(
            limpiar(fila.get("cobertura_geografica", "")),
            limpiar(fila.get("cobertura_codigo", "")),
        ),
    }


# ─────────────────────────────────────────────
# LECTURA DEL ARCHIVO
# ─────────────────────────────────────────────

def leer_archivo(ruta: Path) -> pd.DataFrame:
    """Lee Excel (.xlsx) o CSV y devuelve un DataFrame."""
    sufijo = ruta.suffix.lower()

    if sufijo == ".xlsx":
        return pd.read_excel(ruta, dtype=str)

    elif sufijo == ".csv":
        # Intenta tabulador primero (exportación directa desde Excel),
        # si falla, prueba con coma.
        try:
            df = pd.read_csv(ruta, sep="\t", dtype=str, encoding="utf-8")
            if df.shape[1] > 1:
                return df
        except Exception:
            pass
        return pd.read_csv(ruta, sep=",", dtype=str, encoding="utf-8")

    else:
        print(f"❌ Formato no soportado: {sufijo}. Usa .xlsx o .csv")
        sys.exit(1)


# ─────────────────────────────────────────────
# EJECUCIÓN PRINCIPAL
# ─────────────────────────────────────────────

def main():
    print("═══════════════════════════════════════════")
    print("  Migración Excel → catalogo-capas.json")
    print("═══════════════════════════════════════════\n")

    # Argumento de entrada
    if len(sys.argv) < 2:
        print("USO: python migrar-catalogo.py <archivo.xlsx|archivo.csv>")
        sys.exit(1)

    ruta_entrada = Path(sys.argv[1])
    if not ruta_entrada.exists():
        print(f"❌ Archivo no encontrado: {ruta_entrada}")
        sys.exit(1)

    # Leer
    df = leer_archivo(ruta_entrada)
    df.columns = df.columns.str.strip()  # limpia espacios en cabeceras
    print(f"📄 Filas leídas: {len(df)}\n")

    # Filtrar y transformar
    catalogo  = []
    excluidas = []
    ids_usados = set()

    for i, fila in df.iterrows():
        nombre = limpiar(fila.get("nombre_capa", f"fila {i+2}"))

        incluida, motivo = aplicar_filtros(fila)

        if not incluida:
            excluidas.append({"nombre": nombre, "motivo": motivo})
            continue

        capa = transformar_fila(fila)

        # Garantizar IDs únicos ante colisiones de slug
        id_final = capa["id"]
        sufijo   = 1
        while id_final in ids_usados:
            id_final = f"{capa['id']}-{sufijo}"
            sufijo  += 1
        capa["id"] = id_final
        ids_usados.add(id_final)

        catalogo.append(capa)
        print(f"  ✅ {nombre}")

    # Escribir JSON
    ruta_salida = ruta_entrada.parent / ARCHIVO_SALIDA
    with open(ruta_salida, "w", encoding="utf-8") as f:
        json.dump(catalogo, f, ensure_ascii=False, indent=2)

    # Resumen
    print("\n───────────────────────────────────────────")
    print(f"✅ Capas incluidas:  {len(catalogo)}")
    print(f"❌ Capas excluidas: {len(excluidas)}")

    if excluidas:
        print("\nCapas excluidas (motivo):")
        for e in excluidas:
            print(f"   - {e['nombre']} → {e['motivo']}")

    print(f"\n📦 Archivo generado: {ruta_salida}")
    print("═══════════════════════════════════════════\n")


if __name__ == "__main__":
    main()