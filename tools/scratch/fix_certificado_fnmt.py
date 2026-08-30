"""
fix_certificado_fnmt.py

Descarga la CA intermedia "AC Componentes Informaticos" de FNMT-RCM
(la que emite el certificado de wms.mapama.gob.es y dominios asociados,
confirmado via inspeccion manual del certificado, issuer: FNMT-RCM /
AC Componentes Informaticos) y genera un bundle de confianza combinado:
certifi + esa CA.

Contexto (hallazgo real, 30/08/2026): requests/certifi no incluyen esta
CA intermedia del sector publico espanol en su bundle publico de
Mozilla, aunque Windows/navegadores/QGIS si la resuelven via AIA
(Authority Information Access) automatico. Sin este bundle, cualquier
peticion via requests contra wms.mapama.gob.es y dominios .mapa.gob.es/
.miteco.gob.es/.mapama.es asociados falla con SSLCertVerificationError
aunque el servicio funcione perfectamente.

Uso (desde cualquier directorio, la ruta de salida es siempre relativa
a este archivo, no al directorio de trabajo actual):
    python tools/scratch/fix_certificado_fnmt.py

Salida:
    tools/scratch/cacert_fnmt.pem   -> bundle combinado, listo para usar
                                        con requests (parametro verify=...
                                        o variable de entorno
                                        REQUESTS_CA_BUNDLE)
"""

import base64
import ssl
import urllib.request
from pathlib import Path

import certifi

URL_CA_INTERMEDIA = "http://www.cert.fnmt.es/certs/ACCOMP.crt"

# Ruta de salida SIEMPRE relativa a la ubicacion de este archivo, no al
# directorio de trabajo actual (cwd) — evita que el .pem termine en la
# raiz del repo si el script se invoca como 'python tools\scratch\fix_...'
# desde C:\Dev\geo-app en vez de 'cd' primero a tools\scratch.
RUTA_BUNDLE_SALIDA = Path(__file__).resolve().parent / "cacert_fnmt.pem"


def main():
    print("Descargando CA intermedia FNMT (ACCOMP.crt)...")
    ctx = ssl._create_unverified_context()
    req = urllib.request.Request(URL_CA_INTERMEDIA)
    with urllib.request.urlopen(req, context=ctx, timeout=15) as resp:
        der_bytes = resp.read()

    pem_body = base64.encodebytes(der_bytes).decode()
    pem = f"-----BEGIN CERTIFICATE-----\n{pem_body}-----END CERTIFICATE-----\n"

    print(f"CA descargada ({len(der_bytes)} bytes). Combinando con certifi...")
    with open(certifi.where(), "r", encoding="utf-8") as f:
        bundle_original = f.read()

    with open(RUTA_BUNDLE_SALIDA, "w", encoding="utf-8") as f:
        f.write(bundle_original)
        f.write("\n")
        f.write(pem)

    print(f"Bundle combinado creado en: {RUTA_BUNDLE_SALIDA}")


if __name__ == "__main__":
    main()
