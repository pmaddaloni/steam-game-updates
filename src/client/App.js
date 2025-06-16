import axios from 'axios';
import './App.scss';
import { AuthProvider } from './AuthContext.js';
import Body from './body/AppBody.js';
import Header from './header/Header.js';

axios.defaults.baseURL = window.location.host.includes('steamgameupdates.info') ?
  'https://api.steamgameupdates.info' : 'http://localhost:8080';
axios.defaults.withCredentials = true;

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
