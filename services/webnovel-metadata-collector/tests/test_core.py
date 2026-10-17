import asyncio
import unicodedata
from datetime import datetime, timezone

from app.extractors.base import BaseExtractor
from app.authenticated_extractor import AuthenticatedExtractor
from app.extractors.kakao_page import KakaoPageExtractor
from app.extractors.munpia import MunpiaExtractor
from app.extractors.naver_series import NaverSeriesExtractor
from app.extractors.novelpia import NovelpiaExtractor
from app.extractors.ridi import RidiExtractor
from app.models import NovelMetadata, SearchCandidate
from app.normalizer import authors_match, normalize_title, search_title, title_match_score
from app.resolve_coordinator import ResolveCoordinator
from app.search_service import SearchService


class StubExtractor(BaseExtractor):
    def __init__(
        self,
        platform: str,
        candidates: list[SearchCandidate],
        *,
        search_error: bool = False,
        detail_error: bool = False,
        search_delay: float = 0.0,
    ):
        self.platform = platform
        self.candidates = candidates
        self.search_error = search_error
        self.detail_error = detail_error
        self.search_delay = search_delay
        self.search_completed = False
        self.search_queries: list[str] = []
        self.detail_calls = 0

    async def search(self, query: str) -> list[SearchCandidate]:
        self.search_queries.append(query)
        if self.search_delay:
            await asyncio.sleep(self.search_delay)
        if self.search_error:
            raise RuntimeError("search failed")
        self.search_completed = True
        return [candidate.model_copy(deep=True) for candidate in self.candidates]

    async def get_detail(self, candidate: SearchCandidate) -> NovelMetadata:
        self.detail_calls += 1
        if self.detail_error:
            raise RuntimeError("detail failed")
        return NovelMetadata(
            **candidate.model_dump(),
            fetched_at=datetime.now(timezone.utc),
        )


def test_title_normalization_and_matching() -> None:
    assert normalize_title("합성 성채 기록 [D]") == "합성성채기록"
    assert title_match_score("합성 성채 기록", "합성 성채 기록 [D]") == 1.0
    assert title_match_score(
        "파란 종이상자",
        "파란 종이상자(Paper Box) [BL]",
    ) == 1.0
    assert title_match_score("샘플제로", "샘플:제로(Sample:Zero)") == 1.0
    assert title_match_score("샘플:제로", "샘플:제로(Sample:Zero)") == 1.0
    assert title_match_score(
        "파란 종이상자",
        "파란 종이상자(Paper Box) [BL][단행본] (총 5권/완결)",
    ) == 1.0
    assert normalize_title("합성자의 기록법 (외전)") == "합성자의기록법"
    assert title_match_score("합성자의 기록법", "합성자의 기록법 (외전)") == 1.0
    assert normalize_title("합성자의 기록법 [완전판]") == "합성자의기록법"
    assert authors_match("가상작가가", "글 가상작가가(假想甲), 다른 작가")


def test_standalone_hangul_survives_catalog_query_cleanup() -> None:
    title = "합성요정ㄴ은 산책하고 싶다"
    for form in [title, unicodedata.normalize("NFKC", title), unicodedata.normalize("NFD", title)]:
        assert search_title(form) == title
        assert search_title(f"{form} １－２００ 完.txt") == title
        assert normalize_title(form) == "합성요정ㄴ은산책하고싶다"
    assert normalize_title(title) != normalize_title("합성요정은 산책하고 싶다")


def test_resolution_sends_standalone_hangul_to_catalog_unchanged() -> None:
    title = "합성요정ㄴ은 산책하고 싶다"

    class LiteralCatalog(StubExtractor):
        async def search(self, query):
            self.search_queries.append(query)
            return [SearchCandidate(
                title=title, author="가상작가나", platform="novelpia", platform_work_id="900001",
                source_url="https://novelpia.com/novel/900001",
                cover_url="https://novelpia.com/imagebox/cover/fixture.jpg",
            )] if query == title else []

    extractor = LiteralCatalog("novelpia", [])
    result = asyncio.run(SearchService([extractor]).resolve(f"{title} 1-200 完.txt"))
    assert result.status == "found"
    assert result.match_type == "exact_title"
    assert result.metadata.platform_work_id == "900001"
    assert extractor.search_queries == [title]


def test_distribution_title_extraction_keeps_catalog_queries_conservative() -> None:
    assert search_title("합성 항해일지 1-315 完.txt") == "합성 항해일지"
    assert search_title("가상 독서 기록 1~551화 [완결]") == "가상 독서 기록"
    assert search_title("합성연대기 총 1,800화 연재중") == "합성연대기"
    assert search_title("[텍본] 합성 항해일지 1-315 (완).txt.zip") == "합성 항해일지"
    assert search_title("2X73 1권.epub") == "2x73"
    assert search_title("27 -샘플번호- 1권.epub") == "27 -샘플번호"
    assert search_title("제8합성국.txt") == "제8합성국"
    assert search_title("2073.txt") == "2073"
    assert search_title("2026-08-26.zip") == "2026-08-26"
    assert search_title("[가상의 인물].epub") == "[가상의 인물]"
    assert title_match_score("합성 항해일지 1-315 完", "합성 항해일지") == 1.0


def test_distribution_title_extraction_removes_only_a_trailing_file_copy_suffix() -> None:
    assert search_title("요정은 구름을 키운다 완 (1).txt") == "요정은 구름을 키운다"
    assert search_title("[텍본] 합성 항해일지 1-315 完 (2).txt.zip") == "합성 항해일지"
    assert normalize_title("요정은 구름을 키운다 완 (1)") == "요정은구름을키운다완1"
    assert search_title("작품 (1) 2화.txt") == "작품 (1)"
    assert search_title("작품 (01)") == "작품 (01)"


def test_munpia_search_and_detail_parsing() -> None:
    extractor = MunpiaExtractor()
    search_html = """
    <ul id="list_ul">
      <li onclick="$M.detailSearch.old.view_novel(900002, '');">
        <img class="pic" src="//cdn.example/cover.jpgtb.jpg">
        <p class="genre">현대판타지, 퓨전</p>
        <p class="title"><span class="i_complete">complete</span>합성 성채 기록</p>
        <p class="author">가상작가가 <span></span> 총 552화</p>
        <div class="webtoon_detail"><div class="detail"><p>작품 소개</p></div></div>
      </li>
    </ul>
    """
    candidates = extractor.parse_search_html(search_html)

    assert len(candidates) == 1
    candidate = candidates[0]
    assert candidate.title == "합성 성채 기록"
    assert candidate.author == "가상작가가"
    assert candidate.status == "completed"

    detail_html = """
    <script type="application/ld+json">
    {
      "@type": "Book",
      "name": "합성 성채 기록",
      "author": {"name": "가상작가가"},
      "url": "https://www.munpia.com/novel/detail/900002",
      "image": "https://cdn.example/cover.jpg",
      "description": "상세 작품 소개",
      "genre": ["현대판타지", "퓨전"]
    }
    </script>
    <h5>#회귀 #재벌</h5>
    """
    metadata = extractor.parse_detail_html(detail_html, candidate)

    assert metadata.cover_url == "https://cdn.example/cover.jpg"
    assert metadata.description == "상세 작품 소개"
    assert metadata.genres == ["현대판타지", "퓨전"]
    assert metadata.tags == ["회귀", "재벌"]


def test_naver_series_search_and_detail_parsing() -> None:
    extractor = NaverSeriesExtractor()
    search_html = """
    <ul class="lst_list">
      <li>
        <a class="pic" href="/novel/detail.series?productNo=9000003">
          <img src="https://comicthumb-phinf.pstatic.net/cover.jpg?type=m79">
        </a>
        <div class="cont">
          <h3><a href="/novel/detail.series?productNo=9000003">합성 성채 기록 (총 552화/완결)</a></h3>
          <span class="author">가상작가가</span>
          <p class="dsc">작품 소개</p>
        </div>
      </li>
    </ul>
    """
    candidates = extractor.parse_search_html(search_html)

    assert len(candidates) == 1
    candidate = candidates[0]
    assert candidate.title == "합성 성채 기록"
    assert candidate.status == "completed"
    assert candidate.cover_url == "https://comicthumb-phinf.pstatic.net/cover.jpg"

    detail_html = """
    <meta property="og:title" content="합성 성채 기록">
    <meta property="og:url" content="https://series.naver.com/novel/detail.series?productNo=9000003">
    <div class="aside"><a class="pic_area"><img src="https://comicthumb-phinf.pstatic.net/cover.jpg?type=m260"></a></div>
    <div class="end_dsc">
      <div class="_synopsis">짧은 작품 소개.. <a class="lk_more">더보기</a></div>
      <div class="_synopsis" style="display: none">처음부터 끝까지 들어 있는 전체 작품 소개 <a class="lk_more">접기</a></div>
    </div>
    <ul class="end_info"><li class="info_lst"><ul>
      <li><span>완결</span></li>
      <li><span><a href="?genreCode=208">현판</a></span></li>
      <li><span>글</span><a>가상작가가</a></li>
    </ul></li></ul>
    """
    metadata = extractor.parse_detail_html(detail_html, candidate)

    assert metadata.cover_url == "https://comicthumb-phinf.pstatic.net/cover.jpg"
    assert metadata.description == "처음부터 끝까지 들어 있는 전체 작품 소개"
    assert metadata.genres == ["현판"]
    assert metadata.author == "가상작가가"

    adult_html = """
    <ul class="lst_list"><li>
      <a class="pic" href="/novel/detail.series?productNo=90000004">
        <img src="https://ssl.pstatic.net/static/nstore/thumb/19over_book2_79x119.gif">
      </a>
      <div class="cont">
        <h3><a href="/novel/detail.series?productNo=90000004">성인 작품(89화/미완결)</a></h3>
        <span class="author">작가</span>
      </div>
    </li></ul>
    """
    assert extractor.parse_search_html(adult_html) == []
    adult_candidates = extractor.parse_search_html(adult_html, adult_only=True)
    assert len(adult_candidates) == 1
    assert adult_candidates[0].cover_url is None


def test_kakao_page_search_and_detail_parsing() -> None:
    extractor = KakaoPageExtractor()
    search_payload = {
        "result": {
            "list": [
                {
                    "type": "SERIES",
                    "series_id": 90000005,
                    "title": "합성 성채 기록",
                    "thumbnail": "cover/id",
                    "category_uid": 11,
                    "sub_category": "현판",
                    "age_grade": 0,
                    "authors": "가상작가가",
                    "state": "ST61",
                }
            ]
        }
    }
    candidates = extractor.parse_search_payload(search_payload)

    assert len(candidates) == 1
    candidate = candidates[0]
    assert candidate.platform_work_id == "90000005"
    assert candidate.cover_url.endswith("cover/id")

    overview_payload = {
        "result": {
            "content": {
                "series_id": 90000005,
                "title": "합성 성채 기록",
                "thumbnail": "original/cover",
                "sub_category": "현판",
                "authors": "가상작가가",
                "description": "상세 소개",
                "state": "ST61",
            }
        }
    }
    about_payload = {
        "result": {
            "description": "상세 작품 소개",
            "theme_keyword_list": [{"title": "회귀"}],
        }
    }
    metadata = extractor.parse_detail_payload(overview_payload, about_payload, candidate)

    assert metadata.title == "합성 성채 기록"
    assert metadata.description == "상세 작품 소개"
    assert metadata.tags == ["회귀"]
    assert metadata.genres == ["현판"]


def test_novelpia_search_parsing() -> None:
    extractor = NovelpiaExtractor()
    payload = {
        "status": 200,
        "list": [
            {
                "novel_no": 900006,
                "novel_name": "합성학교에서 구름학으로 가상교실 운영하기",
                "novel_age": 15,
                "writer_nick": "가상작가바",
                "cover_url": "//images.novelpia.com/imagebox/cover/example.wimg",
                "novel_story": "작품 소개",
                "novel_genre_arr": ["판타지", "전생", "중세"],
                "is_complete": 0,
            }
        ],
    }

    candidates = extractor.parse_search_payload(payload)

    assert len(candidates) == 1
    candidate = candidates[0]
    assert candidate.platform_work_id == "900006"
    assert candidate.cover_url == "https://images.novelpia.com/imagebox/cover/example.wimg"
    assert candidate.genres == ["판타지"]
    assert candidate.tags == ["전생", "중세"]
    assert candidate.status == "ongoing"

    detail = extractor.parse_detail_html(
        """
        <meta property="og:image" content="https://images.novelpia.com/img/2025-novelpia2.jpg">
        <img class="cover_img s_inv" src="//images.novelpia.com/imagebox/cover/actual.file">
        """,
        candidate,
    )
    assert detail.cover_url == "https://images.novelpia.com/imagebox/cover/actual.file"


def test_ridi_search_parsing() -> None:
    extractor = RidiExtractor()
    payload = {
        "books": [
            {
                "b_id": "9900000001",
                "title": "합성으로 기록합니다!",
                "author": "가상작가사",
                "is_serial": 1,
                "is_series_complete": True,
                "age_limit": 0,
                "parent_category_name": "판타지 웹소설",
                "category_name": "현대 판타지",
                "tags_info": [
                    {"tag_name": "성장물"},
                    {"tag_name": "웹소설"},
                    {"tag_name": "연재완결"},
                ],
                "desc": (
                    "<b>&lt;책소개&gt;</b>\n비밀의 레시피로 성장하는 이야기"
                    "\n<b>&lt;작가 소개&gt;</b>\n작가 소개 문구"
                ),
            },
            {
                "b_id": "9900000002",
                "title": "합성으로 기록합니다!",
                "author": "가상작가사",
                "is_serial": 0,
                "parent_category_name": "판타지 e북",
                "age_limit": 0,
            },
        ]
    }

    candidates = extractor.parse_search_payload(payload)

    assert len(candidates) == 1
    candidate = candidates[0]
    assert candidate.platform_work_id == "9900000001"
    assert candidate.cover_url == "https://img.ridicdn.net/cover/9900000001/xxlarge#1"
    assert candidate.description == "비밀의 레시피로 성장하는 이야기"
    assert candidate.genres == ["현대 판타지"]
    assert candidate.tags == ["성장물"]
    assert candidate.status == "completed"


def test_optional_authenticated_resolution() -> None:
    public = StubExtractor(
        "public",
        [
            SearchCandidate(
                title="인증 작품.",
                author="작가",
                platform="public",
                platform_work_id="public-1",
                source_url="https://example.com/public-1",
                cover_url="https://example.com/public-1.jpg",
            )
        ],
    )
    adult = StubExtractor(
        "ridi",
        [
            SearchCandidate(
                title="인증 작품",
                author="작가",
                platform="ridi",
                platform_work_id="adult-1",
                source_url="https://example.com/adult-1",
                cover_url="https://example.com/adult-1.jpg",
                tags=["성인"],
            )
        ],
    )

    class StubSessions:
        available = True
        enabled_platforms = {"ridi"}

    coordinator = ResolveCoordinator(
        SearchService([public]),
        StubSessions(),
        [adult],
    )
    response = asyncio.run(
        coordinator.resolve("인증 작품", "작가", include_adult=True)
    )

    assert response.status == "found"
    assert response.authenticated_search is False
    assert response.public_adult_metadata is True
    assert response.metadata is not None
    assert response.metadata.platform == "ridi"


def test_authenticated_extractors_keep_only_adult_candidates() -> None:
    class StubAuthSessions:
        async def fetch_json(self, url, **kwargs):
            if "ridibooks" in url:
                return {
                    "books": [
                        {
                            "b_id": "r1",
                            "title": "리디 성인작",
                            "author": "작가",
                            "is_serial": 1,
                            "age_limit": 19,
                            "parent_category_name": "로맨스 웹소설",
                        }
                    ]
                }
            if "novelpia" in url:
                return {
                    "status": 200,
                    "list": [
                        {
                            "novel_no": "n1",
                            "novel_name": "노벨피아 성인작",
                            "writer_nick": "작가",
                            "novel_age": 19,
                        }
                    ],
                }
            return {
                "result": {
                    "list": [
                        {
                            "type": "SERIES",
                            "series_id": "k1",
                            "title": "카카오 성인작",
                            "authors": "작가",
                            "category_uid": 11,
                            "age_grade": 19,
                        }
                    ]
                }
            }

        async def fetch_novelpia_json(self, url, **kwargs):
            return await self.fetch_json(url, **kwargs)

        async def fetch_novelpia_text(self, url, **kwargs):
            return await self.fetch_text(url, **kwargs)

        async def fetch_text(self, url, **kwargs):
            return """
            <ul class="lst_list"><li>
              <a class="pic" href="/novel/detail.series?productNo=s1">
                <img src="https://ssl.pstatic.net/static/nstore/thumb/19over_book2.gif">
              </a>
              <h3><a href="/novel/detail.series?productNo=s1">시리즈 성인작</a></h3>
              <span class="author">작가</span>
            </li></ul>
            """

    sessions = StubAuthSessions()
    class StubAuthenticatedRidi(RidiExtractor):
        async def search_adult(self, query: str) -> list[SearchCandidate]:
            return self.parse_search_payload(
                {
                    "books": [
                        {
                            "b_id": "r1",
                            "title": "리디 성인작",
                            "author": "작가",
                            "is_serial": 1,
                            "age_limit": 19,
                            "parent_category_name": "로맨스 웹소설",
                        }
                    ]
                },
                adult_only=True,
            )

    class StubPublicKakao(KakaoPageExtractor):
        async def search_adult(self, query: str) -> list[SearchCandidate]:
            return self.parse_search_payload(await sessions.fetch_json(self.api_base_url), adult_only=True)

    extractors = [
        AuthenticatedExtractor(sessions, NaverSeriesExtractor()),
        AuthenticatedExtractor(sessions, StubPublicKakao()),
        AuthenticatedExtractor(sessions, NovelpiaExtractor()),
        AuthenticatedExtractor(sessions, StubAuthenticatedRidi()),
    ]

    async def search_all():
        return await asyncio.gather(
            *(extractor.search("성인작") for extractor in extractors)
        )

    results = asyncio.run(search_all())

    assert [items[0].platform for items in results] == [
        "naver_series",
        "kakao_page",
        "novelpia",
        "ridi",
    ]
    assert all("19금" in items[0].tags for items in results)


def test_resolve_returns_only_the_best_exact_match() -> None:
    exact = StubExtractor(
        "exact",
        [
            SearchCandidate(
                title="합성 성채 기록 [독점]",
                author="가상작가가",
                platform="exact",
                platform_work_id="1",
                source_url="https://example.com/exact",
                cover_url="https://example.com/exact.jpg",
                description="<p>전체&nbsp; 소개</p>",
                genres=["현대판타지", " 현대판타지 "],
                tags=["#회귀", "회귀", " 재벌 "],
            )
        ],
        detail_error=True,
    )
    similar = StubExtractor(
        "similar",
        [
            SearchCandidate(
                title="합성 성채 항해",
                author="같은 작가",
                platform="similar",
                platform_work_id="2",
                source_url="https://example.com/similar",
                cover_url="https://example.com/similar.jpg",
            )
        ],
    )
    failed = StubExtractor("failed", [], search_error=True)

    response = asyncio.run(
        SearchService([similar, exact, failed]).resolve("합성 성채 기록", author="가상작가가")
    )

    assert response.status == "found"
    assert response.metadata is not None
    assert response.metadata.platform_work_id == "1"
    assert response.metadata.description == "전체 소개"
    assert response.metadata.genres == ["현대판타지"]
    assert response.metadata.tags == ["회귀", "재벌"]
    assert response.metadata.status == "unknown"
    assert response.confidence == 1.0
    assert response.match_type == "exact_title_and_author"
    assert response.metadata_quality == "partial"
    assert response.searched_platforms == 2
    assert response.failed_platforms == ["failed"]
    assert response.platform_errors == {
        "failed": "플랫폼에서 검색 결과를 가져오지 못했습니다."
    }
    assert exact.detail_calls == 1
    assert similar.detail_calls == 0


def test_resolve_searches_with_extracted_title_but_preserves_the_request_query() -> None:
    extractor = StubExtractor(
        "catalog",
        [
            SearchCandidate(
                title="합성 항해일지",
                author="가상작가다",
                platform="catalog",
                platform_work_id="synthetic-voyage",
                source_url="https://example.com/synthetic-voyage",
                cover_url="https://example.com/synthetic-voyage.jpg",
            )
        ],
    )

    response = asyncio.run(
        SearchService([extractor]).resolve("합성 항해일지 1-315 完")
    )

    assert extractor.search_queries == ["합성 항해일지"]
    assert response.query == "합성 항해일지 1-315 完"
    assert response.status == "found"
    assert response.match_type == "exact_title"


def test_resolve_prefers_literal_cross_platform_consensus_over_variant_collision() -> None:
    canonical_a = StubExtractor(
        "platform-a",
        [
            SearchCandidate(
                title="가상 독서 기록",
                author="가상작가라",
                platform="platform-a",
                platform_work_id="canonical-a",
                source_url="https://example.com/canonical-a",
                cover_url="https://example.com/canonical-a.jpg",
            ),
            SearchCandidate(
                title="가상 독서 기록[개정판]",
                author="가상작가마",
                platform="platform-a",
                platform_work_id="revision",
                source_url="https://example.com/revision",
                cover_url="https://example.com/revision.jpg",
            ),
        ],
    )
    canonical_b = StubExtractor(
        "platform-b",
        [
            SearchCandidate(
                title="가상 독서 기록",
                author="가상작가라",
                platform="platform-b",
                platform_work_id="canonical-b",
                source_url="https://example.com/canonical-b",
                cover_url="https://example.com/canonical-b.jpg",
            ),
            SearchCandidate(
                title="가상 독서 기록 [단행본]",
                author="가상작가라",
                platform="platform-b",
                platform_work_id="volume",
                source_url="https://example.com/volume",
                cover_url="https://example.com/volume.jpg",
            ),
        ],
    )

    response = asyncio.run(
        SearchService([canonical_a, canonical_b]).resolve("가상독서기록")
    )

    assert response.status == "found"
    assert response.match_type == "exact_title"
    assert response.metadata is not None
    assert response.metadata.title == "가상 독서 기록"
    assert response.metadata.author == "가상작가라"


def test_resolve_keeps_distinct_base_work_authors_ambiguous() -> None:
    first = StubExtractor(
        "platform-a",
        [
            SearchCandidate(
                title="같은 제목",
                author="첫 작가",
                platform="platform-a",
                platform_work_id="first",
                source_url="https://example.com/first",
                cover_url="https://example.com/first.jpg",
            )
        ],
    )
    second = StubExtractor(
        "platform-b",
        [
            SearchCandidate(
                title="같은 제목",
                author="둘째 작가",
                platform="platform-b",
                platform_work_id="second",
                source_url="https://example.com/second",
                cover_url="https://example.com/second.jpg",
            )
        ],
    )

    response = asyncio.run(SearchService([first, second]).resolve("같은 제목"))

    assert response.status == "ambiguous"


def test_variants_are_preferences_not_rejection_conditions() -> None:
    extractor = StubExtractor(
        "platform",
        [
            SearchCandidate(
                title="유리 정원",
                author="작가",
                platform="platform",
                platform_work_id="main",
                source_url="https://example.com/main",
                cover_url="https://example.com/main.jpg",
            ),
            SearchCandidate(
                title="유리 정원 (외전)",
                author="작가",
                platform="platform",
                platform_work_id="side-story",
                source_url="https://example.com/side-story",
                cover_url="https://example.com/side-story.jpg",
            ),
        ],
    )

    main = asyncio.run(SearchService([extractor]).resolve("유리 정원"))
    side_story = asyncio.run(SearchService([extractor]).resolve("유리 정원 외전"))
    only_variant = asyncio.run(
        SearchService(
            [
                StubExtractor(
                    "variant-only",
                    [
                        SearchCandidate(
                            title="유리 정원 [완전판]",
                            author="작가",
                            platform="variant-only",
                            platform_work_id="complete-edition",
                            source_url="https://example.com/complete-edition",
                            cover_url="https://example.com/complete-edition.jpg",
                        )
                    ],
                )
            ]
        ).resolve("유리 정원")
    )

    assert main.metadata and main.metadata.platform_work_id == "main"
    assert side_story.metadata and side_story.metadata.platform_work_id == "side-story"
    assert only_variant.status == "found"
    assert only_variant.metadata
    assert only_variant.metadata.platform_work_id == "complete-edition"


def test_resolve_does_not_choose_a_lower_match_just_for_its_cover() -> None:
    best_without_cover = StubExtractor(
        "best",
        [
            SearchCandidate(
                title="합성학교 구름 교사가 되엇다",
                author="작가",
                platform="best",
                platform_work_id="1",
                source_url="https://example.com/best",
            )
        ],
    )
    lower_with_cover = StubExtractor(
        "lower",
        [
            SearchCandidate(
                title="완전히 다른 작품",
                author="작가",
                platform="lower",
                platform_work_id="2",
                source_url="https://example.com/lower",
                cover_url="https://example.com/lower.jpg",
            )
        ],
    )

    response = asyncio.run(
        SearchService([best_without_cover, lower_with_cover]).resolve(
            "합성학교 구름 교사가 되었다"
        )
    )

    assert response.status == "not_found"
    assert best_without_cover.detail_calls == 1
    assert lower_with_cover.detail_calls == 0


def test_literal_title_wins_normalized_title_tie() -> None:
    extractor = StubExtractor(
        "novelpia",
        [
            SearchCandidate(
                title="합성표본 속으로.",
                author="같은 작가",
                platform="novelpia",
                platform_work_id="public",
                source_url="https://example.com/public",
                cover_url="https://example.com/public.jpg",
                description="메타데이터가 많은 동명 작품",
                tags=["태그"],
            ),
            SearchCandidate(
                title="합성표본 속으로",
                author="같은 작가",
                platform="novelpia",
                platform_work_id="adult",
                source_url="https://example.com/adult",
                cover_url="https://example.com/adult.jpg",
            ),
        ],
    )

    response = asyncio.run(SearchService([extractor]).resolve("합성표본 속으로"))

    assert response.status == "found"
    assert response.metadata is not None
    assert response.metadata.platform_work_id == "adult"


def test_normalized_title_does_not_cancel_slower_literal_match() -> None:
    normalized = StubExtractor(
        "normalized",
        [
            SearchCandidate(
                title="합성표본 속으로.",
                author="같은 작가",
                platform="normalized",
                platform_work_id="normalized",
                source_url="https://example.com/normalized",
                cover_url="https://example.com/normalized.jpg",
            )
        ],
        search_delay=0.01,
    )
    literal = StubExtractor(
        "literal",
        [
            SearchCandidate(
                title="합성표본 속으로",
                author="같은 작가",
                platform="literal",
                platform_work_id="literal",
                source_url="https://example.com/literal",
                cover_url="https://example.com/literal.jpg",
            )
        ],
        search_delay=0.05,
    )

    response = asyncio.run(
        SearchService([normalized, literal]).resolve(
            "합성표본 속으로",
            author="같은 작가",
        )
    )

    assert literal.search_completed
    assert response.metadata is not None
    assert response.metadata.platform_work_id == "literal"


def test_early_consensus_and_batch_resolution() -> None:
    def candidate(title: str, platform: str, work_id: str) -> SearchCandidate:
        return SearchCandidate(
            title=title,
            author="같은 작가",
            platform=platform,
            platform_work_id=work_id,
            source_url=f"https://example.com/{work_id}",
            cover_url=f"https://example.com/{work_id}.jpg",
        )

    fast_a = StubExtractor(
        "fast_a",
        [candidate("합의 작품", "fast_a", "a")],
        search_delay=0.01,
    )
    fast_b = StubExtractor(
        "fast_b",
        [candidate("합의 작품", "fast_b", "b")],
        search_delay=0.02,
    )
    slow = StubExtractor(
        "slow",
        [candidate("합의 작품", "slow", "c")],
        search_delay=0.2,
    )
    catalog = StubExtractor(
        "catalog",
        [
            candidate("첫 작품", "catalog", "first"),
            candidate("둘 작품", "catalog", "second"),
        ],
    )

    async def scenario():
        early = await SearchService([fast_a, fast_b, slow]).resolve("합의 작품")
        batch = await SearchService([catalog]).resolve_batch(
            [("첫 작품", None), ("둘 작품", "같은 작가")]
        )
        return early, batch

    early, batch = asyncio.run(scenario())

    assert early.status == "found"
    assert early.searched_platforms == 2
    assert early.skipped_platforms == ["slow"]
    assert not slow.search_completed
    assert [item.metadata.title for item in batch.results if item.metadata] == [
        "첫 작품",
        "둘 작품",
    ]
