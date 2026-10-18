# 第三方资源 / Third-party resources

This project's own code is licensed under MIT; see [LICENSE](LICENSE). The following independent third-party terms remain applicable.

| Resource | Version / origin | License / attribution |
| --- | --- | --- |
| Chart.js | 4.5.1 | MIT, `vendor/chartjs/4.5.1/LICENSE.Chart.js.txt` |
| Bundled @kurkle/color | 0.3.2 | MIT, `vendor/chartjs/4.5.1/LICENSE.kurkle-color.txt` |
| Leaflet | 1.9.4 | BSD-2-Clause, `vendor/leaflet/1.9.4/LICENSE.txt` |
| World overview | NASA Blue Marble, August 2004 | NASA Earth Observatory / GEBCO; sources in `vendor/leaflet/1.9.4/manifest.json` |
| Street map data / fixture | OpenFreeMap / OpenMapTiles / OpenStreetMap | OpenStreetMap data under ODbL; see `tests/fixtures/MAP-DATA-NOTICE.md` and saved map attribution |
| Retrieved photos | Wikipedia / Wikimedia Commons | Individual creator, license and source retained with each saved image |

Vendored files are integrity-checked at build time. Preserve their licenses and attribution when redistributing source, bundles or exports. Runtime and development npm dependencies retain their package-specific licenses; this table describes the separately bundled assets, not an exhaustive npm dependency license inventory.

内置资源与联网获取内容均需保留各自署名及许可。构建会生成 `lib/THIRD_PARTY_NOTICES.txt` 与 `lib/LEAFLET_NOTICES.txt`，HTML 导出也保留相应声明。
