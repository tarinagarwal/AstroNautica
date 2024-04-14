import React from 'react'
import './PostCard.scss'
import API_BASE_URL from '../../config/config'

const PostCard = ({_id,title,summary,cover,content,createdAt,author}) => {
  return (
    <>
    <div class="projcard-container">
		
        <div class="projcard projcard-blue">
            <div class="projcard-innerbox">
                <img class="projcard-img" src={`${API_BASE_URL}/${cover}`}/>
                <div class="projcard-textbox">
                    <div class="projcard-title">{title}</div>
                    <div class="projcard-subtitle">This explains the card in more detail</div>
                    <div class="projcard-bar"></div>
                    <div class="projcard-description">{summary}</div>
                    <div class="projcard-tagbox">
                        {/* <span class="projcard-tag">{author}</span>
                        <span class="projcard-tag">{createdAt}</span> */}
                    </div>
                </div>
            </div>
        </div>
    
        
    </div>
    </>
  )
}

export default PostCard