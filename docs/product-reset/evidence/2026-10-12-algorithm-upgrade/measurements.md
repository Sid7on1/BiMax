# Paired component measurements

Four warmups, eleven pairs, alternating AB/BA; no discarded timings. Units: ms. All output-equality assertions pass. This is not installed task or quality measurement.

| Case | Before p50 | After p50 | Before/after | Before p95 | After p95 |
|---|---:|---:|---:|---:|---:|
| bm25 N=100 query=needle exactSymbol | 0.0769 | 0.0478 | 1.61× | 0.0918 | 0.0671 |
| bm25 N=100 query=common | 0.0712 | 0.0714 | 1.00× | 0.1612 | 0.1314 |
| bm25 N=100 query=notpresent | 0.0315 | 0.0097 | 3.25× | 0.0471 | 0.0129 |
| bm25 build N=100 | 0.3714 | 0.4216 | 0.88× | 0.4492 | 0.6546 |
| bm25 N=1000 query=needle exactSymbol | 0.1223 | 0.0553 | 2.21× | 0.2097 | 0.1020 |
| bm25 N=1000 query=common | 0.2756 | 0.2984 | 0.92× | 0.4719 | 0.5392 |
| bm25 N=1000 query=notpresent | 0.0666 | 0.0100 | 6.63× | 0.0740 | 0.0163 |
| bm25 build N=1000 | 2.7510 | 2.7706 | 0.99× | 2.8850 | 3.0279 |
| bm25 N=10000 query=needle exactSymbol | 0.4662 | 0.1648 | 2.83× | 0.7956 | 0.3988 |
| bm25 N=10000 query=common | 1.4777 | 1.5579 | 0.95× | 1.6448 | 1.6954 |
| bm25 N=10000 query=notpresent | 0.5137 | 0.0157 | 32.70× | 0.5206 | 0.0243 |
| bm25 build N=10000 | 23.8782 | 24.6348 | 0.97× | 24.1108 | 24.9684 |
| top-k N=100 k=64 order=random | 0.0204 | 0.1167 | 0.17× | 0.0315 | 0.1399 |
| top-k N=100 k=64 order=ascending | 0.0073 | 0.0582 | 0.13× | 0.0113 | 0.0857 |
| top-k N=100 k=64 order=descending | 0.0059 | 0.0460 | 0.13× | 0.0108 | 0.0724 |
| top-k N=100 k=64 order=tied | 0.0241 | 0.0448 | 0.54× | 0.0602 | 0.0530 |
| top-k N=1000 k=64 order=random | 0.1431 | 0.1047 | 1.37× | 0.2537 | 0.1254 |
| top-k N=1000 k=64 order=ascending | 0.0487 | 0.3174 | 0.15× | 0.0795 | 0.3419 |
| top-k N=1000 k=64 order=descending | 0.0611 | 0.0702 | 0.87× | 0.2885 | 0.1095 |
| top-k N=1000 k=64 order=tied | 0.2285 | 0.0982 | 2.33× | 0.2417 | 0.1319 |
| top-k N=10000 k=64 order=random | 1.9934 | 0.4513 | 4.42× | 2.0586 | 0.4707 |
| top-k N=10000 k=64 order=ascending | 0.4836 | 1.6079 | 0.30× | 0.4919 | 1.6320 |
| top-k N=10000 k=64 order=descending | 0.4471 | 0.4852 | 0.92× | 0.4866 | 0.5029 |
| top-k N=10000 k=64 order=tied | 1.1265 | 0.4210 | 2.68× | 1.1517 | 0.4303 |
| top-k N=100000 k=64 order=random | 23.8809 | 1.6076 | 14.86× | 24.2305 | 1.6372 |
| top-k N=100000 k=64 order=ascending | 1.8052 | 14.3947 | 0.13× | 1.9707 | 15.5100 |
| top-k N=100000 k=64 order=descending | 1.7819 | 1.9928 | 0.89× | 1.8866 | 2.1237 |
| top-k N=100000 k=64 order=tied | 10.0842 | 1.8665 | 5.40× | 10.1750 | 1.9106 |
| breaker N=100 cap=10000 | 0.0967 | 0.1229 | 0.79× | 0.1552 | 0.1412 |
| breaker N=10000 cap=10000 | 3.4337 | 2.1977 | 1.56× | 5.6538 | 2.6656 |
| breaker N=100000 cap=10000 | 9.3265 | 5.2892 | 1.76× | 10.4645 | 5.7560 |
| file-cache N=100 cap=100 | 0.3322 | 0.1838 | 1.81× | 0.6798 | 0.1975 |
| file-cache N=10000 cap=100 | 9.3155 | 3.1482 | 2.96× | 10.4002 | 3.6442 |

Ratios below 1 are regressions. Score candidate retention is measured separately as a count, not peak RSS. The microbenchmark includes selection and output materialization, not vector computation or store I/O.

{
  "platform": "darwin",
  "arch": "arm64",
  "release": "27.0.0",
  "cpu": "Apple M3",
  "cores": 8,
  "memory_bytes": 8589934592,
  "node": "v22.13.1"
}
