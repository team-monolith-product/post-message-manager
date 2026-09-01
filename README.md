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

### 스트림 등록 및 소비

`registerStream`으로 스트림 공급자를 등록하고 `stream`이 반환하는
`AsyncGenerator`를 `for await...of`로 소비합니다.

공급자 window:

```typescript
const provider = new PostMessageManager();

provider.registerStream({
  messageType: "progress",
  callback: (_payload, controller) => {
    for (const progress of [25, 50, 100]) {
      if (controller.signal.aborted) {
        return;
      }
      controller.enqueue(progress);
    }
    controller.close();
  },
});
```

소비자 window:

```typescript
const consumer = new PostMessageManager();

for await (const progress of consumer.stream<number>({
  messageType: "progress",
  payload: null,
  target: window.parent,
  targetOrigin: "https://example.com",
  idleTimeoutMs: 30000,
})) {
  console.log("진행률:", progress);
}
```

루프를 중간에 끝내거나 `AbortSignal`을 abort하면 공급자의
`controller.signal`도 abort됩니다. `idleTimeoutMs` 동안 청크가 없으면
스트림이 에러로 끝나고 공급자에 취소가 전달됩니다.

### 핸들러 제거

```typescript
manager.unregister("getUserInfo");
provider.unregisterStream("progress");
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

### `registerStream(args: RegisterStreamProps): void`

스트림 공급자를 등록합니다. callback은 `enqueue`, `close`, `error`,
`signal`을 제공하는 controller를 받습니다.

### `unregisterStream(messageType: string): void`

등록된 스트림 공급자를 제거합니다.

### `stream<T>(args: StreamProps): AsyncGenerator<T, void, void>`

다른 window에 스트림을 요청하고 청크를 순서대로 소비하는
`AsyncGenerator`를 반환합니다. `signal`과 `idleTimeoutMs`로 취소 조건을
설정할 수 있습니다.

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

## 빌드

```bash
# 빌드 (전체)
npm run build

# NPM용 빌드
npm run build:npm

# 브라우저용 빌드 (IIFE), dist/post-message-manager.js 생성
npm run build:browser
```
