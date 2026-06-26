# Travel Doctor - GPT API AI Care Version

추가된 내용:
- Netlify Function `/.netlify/functions/ai-care`
- `OPENAI_API_KEY` 환경변수를 서버에서만 사용
- AI Care 버튼을 누르면 OpenAI Responses API로 증상 판단
- GPT 응답을 JSON으로 받아 기존 AI Care 화면에 표시
- API 실패 시 기존 규칙 기반 AI Care로 fallback

배포 전 확인:
OPENAI_API_KEY 환경변수가 Netlify에 저장되어 있어야 합니다.

배포 방법:
이 폴더 전체를 Netlify에 업로드하세요. index.html만 올리면 Function이 배포되지 않습니다.


## 2026-06-09 route mode fix
- 도보 길찾기 버튼: Google Maps `travelmode=walking`
- 자동차 길찾기 버튼: Google Maps `travelmode=driving`
- 대중교통 길찾기 버튼: Google Maps `travelmode=transit`
- 모바일 Google Maps에서 버스 모드로 고정되는 문제를 줄이기 위해 `dir_action=navigate` 제거
- origin을 `Current Location` 문자열 대신 앱 기준 위치 좌표로 전달하도록 수정
