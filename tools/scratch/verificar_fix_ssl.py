"""
verificar_fix_ssl.py

Prueba una peticion real contra wms.mapama.gob.es usando el bundle
combinado generado por fix_certificado_fnmt.py, para confirmar que
el problema de SSL quedo resuelto antes de correr enriquecer-catalogo.py
sobre las 94 candidatas completas.

Uso (desde cualquier directorio, la ruta del bundle es siempre relativa
a este archivo, no al directorio de trabajo actual):
    python tools/scratch/verificar_fix_ssl.py
"""

from pathlib import Path

import requests

URL_PRUEBA = (
    "https://wms.mapama.gob.es/sig/Alimentacion/IndustriasAgroalimentarias"
    "?request=GetCapabilities&service=WMS"
)
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
}

# Misma logica que en fix_certificado_fnmt.py: ruta relativa a este
# archivo, no al cwd, para que funcione sin importar desde donde se
# invoque el script.
RUTA_BUNDLE = Path(__file__).resolve().parent / "cacert_fnmt.pem"


def main():
    if not RUTA_BUNDLE.exists():
        print(f"❌ No se encontró {RUTA_BUNDLE}")
        print("   Corré primero: python tools/scratch/fix_certificado_fnmt.py")
        return

    print(f"Probando {URL_PRUEBA}")
    print(f"Usando bundle: {RUTA_BUNDLE}\n")
    try:
        r = requests.get(URL_PRUEBA, headers=HEADERS, timeout=15, verify=str(RUTA_BUNDLE))
        print("STATUS:", r.status_code)
        print("LEN:", len(r.content))
        if r.status_code == 200:
            print("\nOK - el certificado ya verifica correctamente.")
    except Exception as e:
        print("TIPO ERROR:", type(e).__name__)
        print("DETALLE:", e)


if __name__ == "__main__":
    main()
