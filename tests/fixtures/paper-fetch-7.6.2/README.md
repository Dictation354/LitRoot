# paper-fetch 7.6.2 publication dates regression

`extracted.md` is an unchanged copy of the approved real golden fixture:

- Source: https://github.com/Dictation354/paper-fetch-skill/blob/97bed12b3fa1bf3ba5e6a91faf973388bc884549/tests/fixtures/golden_criteria/10.1038_s41561-022-00974-7/extracted.md
- Commit: `97bed12b3fa1bf3ba5e6a91faf973388bc884549`
- SHA-256: `6798ee59d9d9b7cda86f13271b15f96e2fd1b5384d25f8416839e89994aac1e9`

Its frontmatter has `publication_dates` with slash-separated dates and no explicit
`year`. The expected publication year is 2022. Tests read this local copy without
network access or a checkout of the source repository.
