# Çalışma notları

Komut paleti üzerinde çalışırken aldığım notlar. Henüz depoya eklemedim; düzenli
bir belgeye dönüşünce `docs/` altına taşıyacağım.

## Yapılacaklar

- [x] Komut kaydını (`src/features/palette/commands.ts`) ayrı bir modüle taşı
- [x] `ctrl+k` kısayolunu paleti açacak şekilde bağla
- [ ] Bulanık eşleştirmede büyük/küçük harf duyarlılığını Türkçe için düzelt
- [ ] Son kullanılan komutları listenin başına al
- [ ] Ekran okuyucular için `aria-activedescendant` desteği ekle

## Türkçe karakterler ve arama

`"İstanbul".toLowerCase()` çağrısı JavaScript'te `"i̇stanbul"` döndürüyor; yani
noktalı büyük İ, noktalı küçük i artı birleştirici bir nokta işaretine dönüşüyor.
Bu yüzden "ist" araması beklenen sonucu bulamıyor. Çözüm olarak eşleştirmeden önce
`toLocaleLowerCase("tr")` kullanmayı ve metni NFC biçimine getirmeyi deneyeceğim.

| Girdi      | `toLowerCase()` | `toLocaleLowerCase("tr")` |
| ---------- | --------------- | ------------------------- |
| `İ`        | `i̇`             | `i`                       |
| `I`        | `i`             | `ı`                       |
| `Ş`        | `ş`             | `ş`                       |

## Sorular

1. Palet açıkken `Esc` yalnızca paleti mi kapatmalı, yoksa seçimi de mi temizlemeli?
2. Komut sayısı yüzü geçerse sonuçları sanal liste ile mi göstermeliyiz?

> Not: Performans ölçümleri `bench/fuzzy-match.bench.ts` içinde. Ölçümleri
> yalnızca yayın derlemesinde çalıştırmak gerekiyor; geliştirme modunda sonuçlar
> yanıltıcı oluyor.
