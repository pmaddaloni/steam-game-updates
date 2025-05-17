import './App.scss';
import { AuthProvider } from './AuthContext.js';
import Body from './body/AppBody.js';
import Header from './header/Header.js';

function App() {
  return (
    <AuthProvider>
      <div className="App">
        <Header />
        <Body />
      </div>
    </AuthProvider>
  );
}

export default App;
