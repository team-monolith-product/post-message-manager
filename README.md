# Post Message Manager

`window.postMessage` API를 사용한 크로스 윈도우 통신을 쉽게 관리할 수 있는 TypeScript 라이브러리입니다.

## 특징

- 🔄 **양방향 통신**: `send` 메서드로 메시지를 보내고 응답을 `Promise`로 받을 수 있습니다
- 📢 **단방향 통신**: `notify` 메서드로 응답이 필요 없는 메시지를 전송할 수 있습니다
- 🔒 **Origin 검증**: 메시지 수신 시 origin 검증을 통해 보안을 강화할 수 있습니다
- ⏱️ **타임아웃 처리**: 응답이 오지 않을 때 자동으로 타임아웃 처리합니다
- 📝 **TypeScript 지원**: 완전한 타입 정의를 제공합니다

## 설치

```bash
npm install @team-monolith/post-message-manager
```

## 사용법

### 기본 설정

```typescript
import PostMessageManager from "@team-monolith/post-message-manager";

// 인스턴스 생성 (기본 타임아웃: 3000ms)
const manager = new PostMessageManager();

// 또는 커스텀 타임아웃 설정
const manager = new PostMessageManager(5000); // 5초
```

### 메시지 핸들러 등록하기

다른 윈도우로부터 메시지를 받을 때 실행할 콜백을 등록합니다.

```typescript
// 기본 등록
manager.register({
  messageType: "getUserInfo",
  callback: (payload) => {
    console.log("받은 데이터:", payload);
    return { name: "John", age: 30 };
  },
});

// origin 검증과 함께 등록
manager.register({
  messageType: "sensitiveData",
  callback: (payload) => {
    return { secret: "data" };
  },
  origin: "https://trusted-domain.com", // 특정 origin만 허용
});

// 함수형 origin 검증
manager.register({
  messageType: "flexibleCheck",
  callback: (payload) => {
    return { data: "response" };
  },
  origin: (origin) => {
    // 여러 도메인 허용
    return origin.endsWith(".mycompany.com");
  },
});

// 비동기 콜백
manager.register({
  messageType: "fetchData",
  callback: async (payload) => {
    const data = await fetch("/api/data");
    return data.json();
  },
});
```

### 메시지 보내고 응답 받기 (양방향)

`send` 메서드는 메시지를 보내고 응답을 Promise로 반환합니다.

```typescript
try {
  const response = await manager.send({
    messageType: "getUserInfo",
    payload: { userId: 123 },
    target: iframe.contentWindow, // 메시지를 받을 window 객체
    targetOrigin: "https://example.com", // 타겟 origin
    timeoutMs: 5000, // 선택적: 이 요청만의 타임아웃 설정
  });

  console.log("응답:", response);
} catch (error) {
  console.error("에러:", error); // 타임아웃 또는 기타 에러
}
```

### 메시지 보내기만 하기 (단방향)

응답이 필요 없는 경우 `notify`를 사용합니다.

```typescript
manager.notify({
  messageType: "logEvent",
  payload: { event: "button_clicked", timestamp: Date.now() },
  target: window.opener,
  targetOrigin: "https://example.com",
});
```

### 스트림 보내고 받기

```typescript
manager.registerStream<string>({
  messageType: "generateText",
  callback: ({ prompt }) =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(`${prompt}: first`);
        controller.enqueue(`${prompt}: second`);
        controller.close();
      },
    }),
  origin: "https://trusted-site.com",
});
```

`stream()`은 호출 즉시 요청하고 스트림이 열리면 `ReadableStream`을 반환합니다. 스트림이나 `AbortSignal`을 취소하면 공급자에도 취소 사유가 전달됩니다.

```typescript
const controller = new AbortController();

const stream = await manager.stream<string>({
  messageType: "generateText",
  payload: { prompt: "hello" },
  target: iframe.contentWindow!,
  targetOrigin: "https://trusted-site.com",
  signal: controller.signal,
  timeoutMs: 5000,
});
const reader = stream.getReader();
try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    console.log(value);
  }
} finally {
  try {
    await reader.cancel();
  } finally {
    reader.releaseLock();
  }
}
```

브라우저가 transferable `ReadableStream`을 지원하면 native 전송을 사용합니다. 지원하지 않으면 내부 `MessagePort` 전송을 사용합니다. `registerStream` callback이 실패하면 소비자에게 즉시 오류를 전달합니다.

### 핸들러 제거

```typescript
manager.unregister("getUserInfo");
```

## 실전 예제

### 부모 윈도우와 iframe 간 통신

**부모 윈도우 (parent.html)**

```typescript
import PostMessageManager from "@team-monolith/post-message-manager";

const manager = new PostMessageManager();

// iframe에서 보내는 메시지 핸들러 등록
manager.register({
  messageType: "requestUserData",
  callback: async (payload) => {
    const userData = await fetchUserData(payload.userId);
    return userData;
  },
  origin: "https://child-iframe.com",
});

// iframe으로 메시지 보내기
const iframe = document.getElementById("myIframe") as HTMLIFrameElement;

iframe.onload = async () => {
  try {
    const response = await manager.send({
      messageType: "initialize",
      payload: { theme: "dark", lang: "ko" },
      target: iframe.contentWindow!,
      targetOrigin: "https://child-iframe.com",
    });
    console.log("iframe 초기화 완료:", response);
  } catch (error) {
    console.error("초기화 실패:", error);
  }
};
```

**iframe (child.html)**

```typescript
import PostMessageManager from "@team-monolith/post-message-manager";

const manager = new PostMessageManager();

// 부모로부터 초기화 메시지 받기
manager.register({
  messageType: "initialize",
  callback: (payload) => {
    applyTheme(payload.theme);
    setLanguage(payload.lang);
    return { status: "initialized" };
  },
  origin: "https://parent-site.com",
});

// 부모에게 사용자 데이터 요청
async function loadUserData(userId: number) {
  try {
    const userData = await manager.send({
      messageType: "requestUserData",
      payload: { userId },
      target: window.parent,
      targetOrigin: "https://parent-site.com",
    });
    return userData;
  } catch (error) {
    console.error("사용자 데이터 로드 실패:", error);
  }
}
```

## API 레퍼런스

### `constructor(timeoutMs?: number)`

- `timeoutMs`: 기본 타임아웃 시간 (밀리초). 기본값: 3000ms

### `register(args: RegisterProps): void`

메시지 핸들러를 등록합니다.

```typescript
interface RegisterProps {
  messageType: string;
  callback: (payload: any) => Promise<any> | any;
  origin?: string | ((origin: string) => boolean);
}
```

### `unregister(messageType: string): void`

등록된 메시지 핸들러를 제거합니다.

### `registerStream<T>(args: RegisterStreamProps<T>): void`

```typescript
interface RegisterStreamProps<T> {
  messageType: string;
  callback: (payload: any) => ReadableStream<T> | Promise<ReadableStream<T>>;
  origin?: string | ((origin: string) => boolean);
}
```

### `unregisterStream(messageType: string): void`

새 요청을 받지 않도록 스트림 핸들러를 제거합니다. 이미 시작된 스트림은 계속 진행합니다. 개별 스트림은 `cancel()`이나 `AbortSignal`로 취소합니다. 일반 메시지 핸들러와 스트림 핸들러는 같은 이름으로 등록할 수 있으며 각각 `unregister()`와 `unregisterStream()`으로 제거합니다.

### `send<T>(args: SendProps): Promise<T>`

메시지를 보내고 응답을 기다립니다.

```typescript
interface SendProps {
  messageType: string;
  payload: any;
  target: Window;
  targetOrigin: string;
  timeoutMs?: number; // 선택적: 이 요청만의 타임아웃
}
```

### `notify(args: NotifyProps): void`

응답을 기다리지 않고 메시지를 보냅니다.

```typescript
type NotifyProps = Omit<SendProps, "timeoutMs">;
```

### `stream<T>(args: StreamProps): Promise<ReadableStream<T>>`

```typescript
interface StreamProps extends SendProps {
  signal?: AbortSignal;
}
```

`timeoutMs`는 호출부터 스트림이 열릴 때까지 기다리는 시간입니다. 기한이 지나면 요청이 실패하고 뒤늦게 반환되는 공급자 스트림도 취소됩니다. `signal`은 요청 시작 전부터 스트림을 읽는 동안까지 적용되며 취소 사유는 `signal.reason`입니다.

공급자는 스트림을 빠르게 반환하고, `cancel()`에서 자신의 네트워크 요청을 중단해야 합니다. callback이 스트림을 반환할 때까지 내부 작업의 생명주기는 callback이 관리합니다. 취소된 요청에서 반환한 스트림은 PMM이 취소합니다. SSE의 첫 응답 기한, 재시도, chunk 사이의 대기 시간은 호출부가 정합니다.

## 주의사항

### Origin 검증의 중요성

보안을 위해 반드시 `origin` 옵션을 사용하여 신뢰할 수 있는 출처의 메시지만 처리하세요.

```typescript
// ❌ 나쁜 예: origin 검증 없음
manager.register({
  messageType: "sensitiveData",
  callback: (payload) => {
    return { creditCard: "1234-5678" };
  },
});

// ✅ 좋은 예: origin 검증 있음
manager.register({
  messageType: "sensitiveData",
  callback: (payload) => {
    return { creditCard: "1234-5678" };
  },
  origin: "https://trusted-site.com",
});
```

### 타임아웃 처리

응답이 늦어질 수 있는 경우 타임아웃을 조정하세요.

```typescript
// 긴 작업의 경우 타임아웃을 늘림
const response = await manager.send({
  messageType: "heavyComputation",
  payload: data,
  target: worker,
  targetOrigin: "*",
  timeoutMs: 30000, // 30초
});
```

### 메모리 누수 방지

컴포넌트나 윈도우가 언마운트될 때는 핸들러를 제거하세요.

```typescript
// React 예제
useEffect(() => {
  manager.register({
    messageType: "update",
    callback: handleUpdate,
  });

  return () => {
    manager.unregister("update");
  };
}, []);
```

## 로컬 브라우저 테스트

의존성을 설치한 뒤 다음 명령으로 브라우저 번들을 빌드하고 로컬 테스트 서버를 실행합니다.

```sh
npm run e2e
npm run e2e -- --browser default
npm run e2e -- --browser chrome
npm run e2e -- --browser safari
npm run e2e -- --browser firefox
```

브라우저를 지정하지 않으면 URL만 출력합니다. 설치된 로컬 브라우저로 URL을 열어도 됩니다. `safari` 선택은 macOS에서만 지원합니다. 앱을 열지 못하면 URL을 직접 열도록 안내하며 서버는 유지됩니다. WebDriver, 브라우저 자동화 권한, 원격 서비스는 필요하지 않습니다.

페이지는 서로 다른 localhost 포트의 iframe으로 자동 선택된 전송 경로와 강제 fallback을 검사하고 PASS/FAIL, user agent, 전송 경로 및 상세 결과를 표시합니다. Safari에서 native transfer를 지원하지 않으면 자동 선택 검사도 fallback으로 실행합니다. 버전 조합 테스트는 이 명령에 포함하지 않습니다.

이 명령은 서버를 유지하며, 브라우저 테스트 실패를 프로세스 종료 코드로 반환하지 않습니다. 결과는 페이지와 터미널에서 확인하고 Ctrl+C로 종료합니다. CI에는 연결되어 있지 않습니다. `npm run test:e2e`는 실행 옵션과 서버의 단위 검사이며 실제 브라우저 검증이 아닙니다.

## 빌드

```bash
# 빌드 (전체)
npm run build

# NPM용 빌드
npm run build:npm

# 브라우저용 빌드 (IIFE), dist/post-message-manager.js 생성
npm run build:browser
```
